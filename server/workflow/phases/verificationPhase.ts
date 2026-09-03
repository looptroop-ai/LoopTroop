import type { TicketContext, TicketEvent } from '../../machines/types'
import { withCommandLoggingAsync } from '../../log/commandLogger'
import { handleMockExecutionUnsupported } from './executionPhase'
import type { PromptPart } from '../../opencode/types'
import { CancelledError, throwIfAborted, type RawAttempt } from '../../council/types'
import { throwIfCancelled } from '../../lib/abort'
import { COMMAND_OUTPUT_SLICE_LENGTH, MODEL_OUTPUT_PREVIEW_LENGTH } from '../../lib/constants'
import { buildMinimalContext, type TicketState } from '../../opencode/contextBuilder'
import { buildPromptFromTemplate, PROM0, PROM13b, PROM24, PROM53 } from '../../prompts/index'
import { getLatestPhaseArtifact, getTicketPaths, insertPhaseArtifact, countPhaseArtifacts, upsertLatestPhaseArtifact } from '../../storage/tickets'
import {
  formatPromptText,
  runOpenCodePrompt,
  runOpenCodeSessionPrompt,
  type OpenCodePromptCompletedEvent,
  type OpenCodePromptDispatchEvent,
  type OpenCodeRunResult,
} from '../runOpenCodePrompt'
import { safeAtomicWrite } from '../../io/atomicWrite'
import { buildRelevantFilesArtifact, type RelevantFilesData } from '../../ticket/relevantFiles'
import {
  normalizeBeadSubsetYamlOutput,
  normalizeRelevantFilesOutput,
  normalizeCoverageResultOutput,
  buildStructuredRetryPrompt,
  type CoverageResultEnvelope,
  type RelevantFilesOutputPayload,
  type StructuredOutputResult,
} from '../../structuredOutput'
import { buildYamlDocument } from '../../structuredOutput/yamlUtils'
import { isMockOpenCodeMode } from '../../opencode/factory'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { runPreFlightChecks } from '../../phases/preflight/doctor'
import type { FinalTestGenerationResult } from '../../phases/finalTest/generator'
import { executeFinalTestWithRetries } from '../../phases/finalTest/executor'
import { parseFinalTestCommands } from '../../phases/finalTest/parser'
import { executeFinalTestCommands } from '../../phases/finalTest/runner'
import {
  EXECUTION_SETUP_PROFILE_ARTIFACT_TYPE,
  EXECUTION_SETUP_PROFILE_MIRROR,
} from '../../phases/executionSetup/types'
import {
  runtimeEnvironmentSchema,
  type RuntimeEnvironment,
} from '@shared/commandSpec'
import {
  buildFinalTestFileEffectsAudit,
  captureFinalTestDirtyFiles,
  FINAL_TEST_FILE_EFFECTS_AUDIT_ARTIFACT,
  type FinalTestFileEffect,
  type FinalTestDirtyFile,
} from '../../phases/finalTest/fileEffectsAudit'
import {
  getExecutionSetupCommitExcludedRoots,
  recordWorktreeStartCommit,
  resetWorktreeToCommit,
  WORKTREE_RESET_PRESERVE_PATHS,
} from '../../phases/execution/gitOps'
import { broadcaster } from '../../sse/broadcaster'
import { resolveInterviewCoverageFollowUpResolution } from '../interviewCoverageFollowUps'
import { resolveCoverageGapDisposition, resolveCoverageRunState } from '../coverageControl'
import { calculateFollowUpLimit } from '../../phases/interview/followUpBudget'
import { parsePrdRefinedArtifact } from '../../phases/prd/refined'
import {
  buildPrdCoverageRevisionArtifact,
  buildPrdCoverageRevisionRetryPrompt,
  buildPrdCoverageRevisionUiDiff,
  validatePrdCoverageRevisionOutput,
} from '../../phases/prd/coverageRevision'
import {
  buildBeadsCoverageRevisionArtifact,
  buildBeadsCoverageRevisionRetryPrompt,
  parseBeadsCoverageRevisionCandidate,
  parseBeadsCoverageRevisionRefinedContent,
  validateBeadsCoverageRevisionOutput,
} from '../../phases/beads/coverageRevision'
import { parseCompiledInterviewArtifact } from '../../phases/interview/compiled'
import { BEADS_PIPELINE_STEPS, getRefinementBeadMetrics, parseBeadsRefinedArtifact } from '../../phases/beads/refined'
import { hydrateExpandedBeads } from '../../phases/beads/expand'
import { clearContextCache } from '../../opencode/contextBuilder'
import {
  countCoverageFollowUpQuestions,
  buildCoverageFollowUpBatch,
  recordPreparedBatch,
  clearInterviewSessionBatch,
} from '../../phases/interview/sessionState'
import { adapter, interviewQASessions } from './state'
import {
  emitPhaseLog,
  emitModelSystemLog,
  emitAiMilestone,
  emitOpenCodeSessionLogs,
  emitOpenCodeStreamEvent,
  emitOpenCodePromptLog,
  createOpenCodeStreamState,
  resolveCouncilRuntimeSettings,
  resolveAiResponseRuntimeSettings,
  resolveCoverageRuntimeSettings,
  resolveStructuredRetryRuntimeSettings,
  resolveInterviewDraftSettings,
  resolveExecutionRuntimeSettings,
  resolveCouncilMembers,
  loadTicketDirContext,
  buildStructuredMetadata,
  buildCoveragePromptConfiguration,
  getCoverageStateLabel,
  getCoverageContextPhase,
  getCoveragePromptTemplate,
  describeCoverageTerminationReason,
} from './helpers'
import type { OpenCodeStreamState } from './types'
import {
  readInterviewSessionSnapshotArtifact,
  loadCanonicalInterview,
  writeCanonicalInterview,
  buildInterviewAnswerSummary,
  persistInterviewSession,
  buildCoverageFollowUpCommentary,
  readMockInterviewWinnerId,
} from './interviewPhase'
import { readTicketBeads, updateTicketProgressFromBeads, writeTicketBeads, buildMockBeadSubsets, readMockBeadsWinnerId } from './beadsPhase'
import { executeBeadsExpandStep } from './beadsPhase'
import { getStructuredRetryDecision } from '../../lib/structuredOutputRetry'
import { persistUiArtifactCompanionArtifact } from '../artifactCompanions'
import { resolveStructuredRetryDiagnostic } from '../../lib/structuredRetryDiagnostics'
import { appendAcceptedRawAttempt, appendRejectedRawAttempt } from '../../lib/structuredRawAttempts'
import { buildStructuredOutputFailure } from '../../structuredOutput/failure'
import { parseUiArtifactCompanionArtifact } from '@shared/artifactCompanions'
import type { UiRefinementDiffArtifact } from '@shared/refinementDiffArtifacts'
import {
  attachOpenCodeBlockedErrorDiagnostics,
  appendBlockedErrorDiagnosticsSummary,
  buildOpenCodeBlockedErrorDiagnostics,
  mergeErrorCodes,
} from '../../opencode/blockedErrorDiagnostics'
import { getErrorMessage } from '@shared/typeGuards'
import { resolveStoredWorkflowPhase, type WorkflowPhaseId } from '@shared/workflowMeta'

type OpenCodeDiagnosticResult = ReturnType<typeof buildOpenCodeBlockedErrorDiagnostics>

function getSessionRetryMessage(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined
  const record = event as { type?: unknown; status?: unknown; message?: unknown }
  if (record.type !== 'session_status' || record.status !== 'retry' || typeof record.message !== 'string') {
    return undefined
  }

  const message = record.message.replace(/\s+/g, ' ').trim()
  return message.length > 0 ? message : undefined
}

function createOpenCodeDiagnosticTracker(modelId: string) {
  let latestSessionRetryMessage: string | undefined
  let latestStepFinishReason: string | undefined
  let latestStepFinishTokens: OpenCodePromptCompletedEvent['responseMeta']['latestStepFinishTokens'] | undefined

  return {
    observeStreamEvent(event: unknown) {
      latestSessionRetryMessage = getSessionRetryMessage(event) ?? latestSessionRetryMessage
      if (event && typeof event === 'object') {
        const record = event as {
          type?: unknown
          step?: unknown
          reason?: unknown
          tokens?: OpenCodePromptCompletedEvent['responseMeta']['latestStepFinishTokens']
        }
        if (record.type === 'step' && record.step === 'finish') {
          latestStepFinishReason = typeof record.reason === 'string' && record.reason.trim().length > 0
            ? record.reason.trim()
            : latestStepFinishReason
          latestStepFinishTokens = record.tokens ?? latestStepFinishTokens
        }
      }
    },
    build(runResult: OpenCodeRunResult): OpenCodeDiagnosticResult {
      const baseResponseMeta = runResult.responseMeta ?? {
        hasAssistantMessage: false,
        latestAssistantWasEmpty: runResult.response.trim().length === 0,
        latestAssistantHasError: false,
        latestAssistantWasStale: false,
        sessionErrored: false,
      }
      const resolvedStepFinishReason = baseResponseMeta.latestStepFinishReason ?? latestStepFinishReason
      const resolvedStepFinishTokens = baseResponseMeta.latestStepFinishTokens ?? latestStepFinishTokens
      const responseMeta = {
        ...baseResponseMeta,
        ...(resolvedStepFinishReason ? { latestStepFinishReason: resolvedStepFinishReason } : {}),
        ...(resolvedStepFinishTokens ? { latestStepFinishTokens: resolvedStepFinishTokens } : {}),
      }
      const sessionRetryFallback = latestSessionRetryMessage && (
        runResult.response.trim().length === 0
        || responseMeta?.latestAssistantWasEmpty
        || responseMeta?.latestAssistantWasStale
        || responseMeta?.latestAssistantHasError
        || responseMeta?.sessionErrored
      )
        ? latestSessionRetryMessage
        : undefined

      return buildOpenCodeBlockedErrorDiagnostics({
        responseMeta,
        attemptMeta: runResult.attemptMeta,
        modelId,
        sessionId: runResult.session.id,
        fallbackMessage: sessionRetryFallback,
      })
    },
  }
}

function errorWithOpenCodeDiagnostics(
  message: string,
  diagnostics: OpenCodeDiagnosticResult | null | undefined,
): Error {
  return attachOpenCodeBlockedErrorDiagnostics(new Error(message), diagnostics)
}

export function validateRelevantFilesScanResponse(response: string): StructuredOutputResult<RelevantFilesOutputPayload> {
  const trimmed = response.trim()
  if (!trimmed) {
    return buildStructuredOutputFailure(response, 'Relevant files output was empty.')
  }

  const normalized = normalizeRelevantFilesOutput(trimmed)

  // Trust the normalizer: if it successfully parsed files, return immediately
  // regardless of tag counts (handles truncated/malformed output)
  if (normalized.ok) {
    return normalized
  }

  // Normalizer failed — enrich with tag-count diagnostics
  const openTagCount = [...trimmed.matchAll(/<RELEVANT_FILES_RESULT>/gi)].length
  const closeTagCount = [...trimmed.matchAll(/<\/RELEVANT_FILES_RESULT>/gi)].length

  if (normalized.error.includes('echoed the prompt')) {
    return normalized
  }

  if (openTagCount !== 1 || closeTagCount !== 1) {
    return buildStructuredOutputFailure(
      response,
      `Relevant files output must contain exactly one <RELEVANT_FILES_RESULT>...</RELEVANT_FILES_RESULT> block (found open=${openTagCount}, close=${closeTagCount}). Parse error: ${normalized.error}`,
      {
        repairWarnings: normalized.repairWarnings,
        retryDiagnostic: normalized.retryDiagnostic,
      },
    )
  }

  return normalized
}

function loadWinnerPrdFullAnswers(ticketId: string, winnerId: string): string | undefined {
  const artifact = getLatestPhaseArtifact(ticketId, 'prd_full_answers')
  if (!artifact) return undefined

  try {
    const parsed = JSON.parse(artifact.content) as { drafts?: Array<{ memberId?: string; outcome?: string; content?: string }> }
    const winnerDraft = parsed.drafts?.find((draft) => (
      draft.memberId === winnerId
      && draft.outcome === 'completed'
      && typeof draft.content === 'string'
      && draft.content.trim().length > 0
    ))
    return winnerDraft?.content
  } catch {
    return undefined
  }
}

function loadRecoveredPrdCoverageContent(ticketId: string) {
  const artifact = getLatestPhaseArtifact(ticketId, 'prd_refined', 'REFINING_PRD')
  if (!artifact) return null

  try {
    const parsed = parsePrdRefinedArtifact(artifact.content)
    return parsed.refinedContent
  } catch {
    return null
  }
}

/** Latest beads candidate blueprint, from the coverage revision if one exists. */
function loadLatestBeadsCandidateContent(ticketId: string): string | null {
  const revisionArtifact = getLatestPhaseArtifact(ticketId, 'beads_coverage_revision', 'VERIFYING_BEADS_COVERAGE')
  if (revisionArtifact) {
    try {
      return parseBeadsCoverageRevisionRefinedContent(revisionArtifact.content)
    } catch {
      return null
    }
  }

  const refinedArtifact = getLatestPhaseArtifact(ticketId, 'beads_refined', 'REFINING_BEADS')
  if (!refinedArtifact) return null
  try {
    return parseBeadsRefinedArtifact(refinedArtifact.content).refinedContent
  } catch {
    return null
  }
}

function loadBeadsExpansionInput(ticketId: string): { candidateContent: string; candidateVersion: number } | null {
  const latestCoverageInput = getLatestBeadsSemanticCoverageInput(ticketId)
  if (latestCoverageInput) return latestCoverageInput

  const refinedArtifact = getLatestPhaseArtifact(ticketId, 'beads_refined', 'REFINING_BEADS')
  if (refinedArtifact) {
    try {
      return { candidateContent: parseBeadsRefinedArtifact(refinedArtifact.content).refinedContent, candidateVersion: 1 }
    } catch { /* ignore */ }
  }

  return null
}

type CoverageAttemptHistoryEntry = {
  candidateVersion: number
  status: 'clean' | 'gaps'
  summary: string
  gaps: string[]
  auditNotes: string
  response: string
  normalizedContent: string
  structuredOutput: ReturnType<typeof buildStructuredMetadata>
  rawAttempts?: RawAttempt[]
  coverageRunNumber: number
  maxCoveragePasses: number
  limitReached: boolean
  terminationReason: string | null
  source?: 'ai_fix_button'
  extraFixNumber?: number
}

type CoverageTransitionHistoryEntry = {
  fromVersion: number
  toVersion: number
  summary: string
  gaps: string[]
  auditNotes: string
  fromContent: string
  toContent: string
  gapResolutions: Array<{
    gap: string
    action: string
    rationale: string
    affectedItems: Array<{ itemType: string; id: string; label: string }>
  }>
  resolutionNotes: string[]
  uiRefinementDiff: UiRefinementDiffArtifact | null
  structuredOutput: ReturnType<typeof buildStructuredMetadata>
  rawAttempts?: RawAttempt[]
  source?: 'ai_fix_button'
  extraFixNumber?: number
  noChange?: boolean
  label?: string
}

type CoverageHistorySnapshot = {
  attempts: CoverageAttemptHistoryEntry[]
  transitions: CoverageTransitionHistoryEntry[]
  finalCandidateVersion?: number
}

type LatestCoverageSnapshot = CoverageHistorySnapshot & {
  winnerId?: string
  status: 'clean' | 'gaps'
  summary: string
  remainingGaps: string[]
  normalizedContent: string
  response: string
  coverageRunNumber: number
  maxCoveragePasses: number
  sourcePhase: WorkflowPhaseId
}

function persistVersionedCoverageArtifact(params: {
  ticketId: string
  stateLabel: WorkflowPhaseId
  phase: 'prd' | 'beads'
  winnerId: string
  response: string
  normalizedContent: string
  parsed: CoverageResultEnvelope
  structuredOutput: ReturnType<typeof buildStructuredMetadata>
  attemptEntry: CoverageAttemptHistoryEntry
  attempts: CoverageAttemptHistoryEntry[]
  transitions: CoverageTransitionHistoryEntry[]
  coverageRunNumber: number
  maxCoveragePasses: number
  limitReached: boolean
  terminationReason?: string | null
  finalCandidateVersion: number
  hasRemainingGaps: boolean
  remainingGaps: string[]
  latestExtraFixSummary?: string | null
}) {
  insertPhaseArtifact(params.ticketId, {
    phase: params.stateLabel,
    artifactType: `${params.phase}_coverage`,
    content: JSON.stringify({
      winnerId: params.winnerId,
      hasGaps: params.attemptEntry.status === 'gaps',
      status: params.attemptEntry.status,
      gaps: params.attemptEntry.gaps,
      summary: params.attemptEntry.summary,
      coverageRunNumber: params.coverageRunNumber,
      maxCoveragePasses: params.maxCoveragePasses,
      limitReached: params.limitReached,
      terminationReason: params.terminationReason ?? null,
      finalCandidateVersion: params.finalCandidateVersion,
      hasRemainingGaps: params.hasRemainingGaps,
      remainingGaps: params.remainingGaps,
      latestExtraFixSummary: params.latestExtraFixSummary ?? null,
      rawAttempts: params.attemptEntry.rawAttempts,
    }),
  })

  persistUiArtifactCompanionArtifact(params.ticketId, params.stateLabel, `${params.phase}_coverage`, {
    response: params.response,
    normalizedContent: params.normalizedContent,
    parsed: params.parsed,
    structuredOutput: params.structuredOutput,
    status: params.attemptEntry.status,
    summary: params.attemptEntry.summary,
    gaps: params.attemptEntry.gaps,
    finalCandidateVersion: params.finalCandidateVersion,
    attempts: params.attempts,
    transitions: params.transitions,
    hasRemainingGaps: params.hasRemainingGaps,
    remainingGaps: params.remainingGaps,
    latestExtraFixSummary: params.latestExtraFixSummary ?? null,
    auditNotes: params.attemptEntry.auditNotes,
    rawAttempts: params.attemptEntry.rawAttempts,
  })
}

function getVersionedCoveragePassLimit(_phase: 'interview' | 'prd' | 'beads', configuredMax: number): number {
  return configuredMax
}

function buildCoverageAttemptSummary(params: {
  phase: 'prd' | 'beads'
  status: 'clean' | 'gaps'
  candidateVersion: number
  gaps: string[]
  remaining: boolean
}): string {
  const candidateLabel = params.phase === 'prd'
    ? `PRD Candidate v${params.candidateVersion}`
    : `Implementation Plan v${params.candidateVersion}`

  if (params.status === 'clean') {
    return params.candidateVersion > 1
      ? `No remaining coverage gaps found in ${candidateLabel}.`
      : `No coverage gaps found in ${candidateLabel}.`
  }

  const gapLabel = params.gaps.length === 1 ? '1 gap' : `${params.gaps.length} gaps`
  return params.remaining
    ? `${candidateLabel} still has ${gapLabel}.`
    : `Coverage found ${gapLabel} in ${candidateLabel}.`
}

function buildCoverageTransitionSummary(params: {
  phase: 'prd' | 'beads'
  fromVersion: number
  toVersion: number
  gaps: string[]
}): string {
  const candidateLabel = params.phase === 'prd' ? 'PRD Candidate' : 'Implementation Plan'
  const gapLabel = params.gaps.length === 1 ? '1 gap' : `${params.gaps.length} gaps`
  return `Coverage found ${gapLabel} in ${candidateLabel} v${params.fromVersion} and created ${candidateLabel} v${params.toVersion}.`
}

function loadCoverageHistorySnapshot(
  ticketId: string,
  phase: 'prd' | 'beads',
  stateLabel: WorkflowPhaseId,
): CoverageHistorySnapshot {
  const artifact = getLatestPhaseArtifact(ticketId, `ui_artifact_companion:${phase}_coverage`, stateLabel)
  if (!artifact) {
    return { attempts: [], transitions: [] }
  }

  const parsed = parseUiArtifactCompanionArtifact(artifact.content)?.payload as Record<string, unknown> | undefined
  if (!parsed) {
    return { attempts: [], transitions: [] }
  }

  return {
    attempts: Array.isArray(parsed.attempts) ? parsed.attempts as CoverageAttemptHistoryEntry[] : [],
    transitions: Array.isArray(parsed.transitions) ? parsed.transitions as CoverageTransitionHistoryEntry[] : [],
    // Candidate versions are positive integers, as `parseBeadsCoverageRevisionCandidate`
    // now insists. A `0`, a negative or a fraction accepted here became
    // `currentCandidateVersion`, and the coverage loop then numbered every
    // later revision from it.
    finalCandidateVersion: typeof parsed.finalCandidateVersion === 'number'
      && Number.isInteger(parsed.finalCandidateVersion)
      && parsed.finalCandidateVersion > 0
      ? parsed.finalCandidateVersion
      : undefined,
  }
}

function getCoverageStateLabels(phase: 'prd' | 'beads'): WorkflowPhaseId[] {
  return phase === 'prd'
    ? ['WAITING_PRD_APPROVAL', 'VERIFYING_PRD_COVERAGE']
    : ['WAITING_BEADS_APPROVAL', 'VERIFYING_BEADS_COVERAGE']
}

function getLatestCoverageArtifactRow(
  ticketId: string,
  phase: 'prd' | 'beads',
  artifactType: string,
) {
  return getCoverageStateLabels(phase)
    .map((stateLabel) => getLatestPhaseArtifact(ticketId, artifactType, stateLabel))
    .filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact))
    .sort((left, right) => right.id - left.id)[0]
}

function parseRecordContent(content: string | null | undefined): Record<string, unknown> {
  if (!content?.trim()) return {}
  try {
    const parsed = JSON.parse(content) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function normalizeCoverageStatus(value: unknown, gaps: string[]): 'clean' | 'gaps' {
  return value === 'clean' ? 'clean' : value === 'gaps' || gaps.length > 0 ? 'gaps' : 'clean'
}

function normalizeCoverageGapsFromRecord(record: Record<string, unknown>): string[] {
  const raw = Array.isArray(record.remainingGaps) && record.remainingGaps.length > 0
    ? record.remainingGaps
    : Array.isArray(record.gaps)
      ? record.gaps
      : []
  return raw
    .filter((gap): gap is string => typeof gap === 'string')
    .map((gap) => gap.trim())
    .filter(Boolean)
}

function loadLatestCoverageSnapshot(
  ticketId: string,
  phase: 'prd' | 'beads',
): LatestCoverageSnapshot | null {
  const coverageArtifactType = `${phase}_coverage`
  const companionArtifactType = `ui_artifact_companion:${coverageArtifactType}`
  const coverageArtifact = getLatestCoverageArtifactRow(ticketId, phase, coverageArtifactType)
  const companionArtifact = getLatestCoverageArtifactRow(ticketId, phase, companionArtifactType)
  if (!coverageArtifact && !companionArtifact) return null

  const coreRecord = parseRecordContent(coverageArtifact?.content)
  const companionRecord = parseUiArtifactCompanionArtifact(companionArtifact?.content ?? '')?.payload as Record<string, unknown> | undefined
  const merged = { ...coreRecord, ...(companionRecord ?? {}) }
  const remainingGaps = normalizeCoverageGapsFromRecord(merged)
  const status = normalizeCoverageStatus(merged.status, remainingGaps)

  return {
    winnerId: typeof merged.winnerId === 'string' ? merged.winnerId : undefined,
    status,
    summary: typeof merged.summary === 'string' ? merged.summary : '',
    remainingGaps,
    normalizedContent: typeof merged.normalizedContent === 'string' ? merged.normalizedContent : '',
    response: typeof merged.response === 'string' ? merged.response : '',
    coverageRunNumber: typeof merged.coverageRunNumber === 'number' ? merged.coverageRunNumber : 0,
    maxCoveragePasses: typeof merged.maxCoveragePasses === 'number' ? merged.maxCoveragePasses : 0,
    attempts: Array.isArray(merged.attempts) ? merged.attempts as CoverageAttemptHistoryEntry[] : [],
    transitions: Array.isArray(merged.transitions) ? merged.transitions as CoverageTransitionHistoryEntry[] : [],
    finalCandidateVersion: typeof merged.finalCandidateVersion === 'number' ? merged.finalCandidateVersion : undefined,
    // Both artifact rows store their phase as free text, so one written by an
    // older build can name a status that no longer exists. The coverage state
    // label for this flow is the correct answer in that case.
    sourcePhase: resolveStoredWorkflowPhase(
      companionArtifact?.phase,
      coverageArtifact?.phase,
      getCoverageStateLabel(phase),
    ),
  }
}

function getPlanningWinnerId(ticketId: string, phase: 'prd' | 'beads'): string {
  const winnerArtifact = phase === 'prd'
    ? getLatestPhaseArtifact(ticketId, 'prd_winner') ?? getLatestPhaseArtifact(ticketId, 'prd_votes')
    : getLatestPhaseArtifact(ticketId, 'beads_winner') ?? getLatestPhaseArtifact(ticketId, 'beads_votes')
  if (!winnerArtifact) {
    throw new Error(`No persisted council winner found for ${phase} coverage extra fix`)
  }

  try {
    const parsed = JSON.parse(winnerArtifact.content) as { winnerId?: string }
    const winnerId = parsed.winnerId?.trim()
    if (winnerId) return winnerId
  } catch {
    // Fall through to the common error below.
  }

  throw new Error(`No winnerId found for ${phase} coverage extra fix`)
}

function countExtraFixTransitions(transitions: CoverageTransitionHistoryEntry[]): number {
  return transitions.filter((transition) => transition.source === 'ai_fix_button').length
}

function buildPreviousExtraFixHistory(transitions: CoverageTransitionHistoryEntry[]) {
  return transitions
    .filter((transition) => transition.source === 'ai_fix_button')
    .map((transition) => ({
      attempt: transition.extraFixNumber ?? 0,
      label: transition.label ?? `Extra Fix ${transition.extraFixNumber ?? '?'}`,
      fromVersion: transition.fromVersion,
      toVersion: transition.toVersion,
      noChange: transition.noChange === true,
      summary: transition.summary,
      gaps: transition.gaps,
      resolutionNotes: transition.resolutionNotes,
    }))
}

function buildExtraFixTransitionSummary(params: {
  phase: 'prd' | 'beads'
  extraFixNumber: number
  fromVersion: number
  toVersion: number
  changed: boolean
  remainingGaps: string[]
}) {
  const candidateLabel = params.phase === 'prd' ? 'PRD Candidate' : 'Implementation Plan'
  const prefix = `Extra Fix ${params.extraFixNumber}`
  if (!params.changed) {
    return params.remainingGaps.length > 0
      ? `${prefix} made no artifact changes; ${params.remainingGaps.length === 1 ? '1 gap remains' : `${params.remainingGaps.length} gaps remain`} in ${candidateLabel} v${params.fromVersion}.`
      : `${prefix} made no artifact changes; no open coverage gaps remain for ${candidateLabel} v${params.fromVersion}.`
  }
  return params.remainingGaps.length > 0
    ? `${prefix} revised ${candidateLabel} v${params.fromVersion} into ${candidateLabel} v${params.toVersion}; ${params.remainingGaps.length === 1 ? '1 gap remains' : `${params.remainingGaps.length} gaps remain`}.`
    : `${prefix} revised ${candidateLabel} v${params.fromVersion} into ${candidateLabel} v${params.toVersion} and cleared all coverage gaps.`
}

function getLatestBeadsSemanticCoverageInput(ticketId: string): { candidateContent: string; candidateVersion: number } | null {
  const revisionArtifact = getCoverageStateLabels('beads')
    .map((stateLabel) => getLatestPhaseArtifact(ticketId, 'beads_coverage_revision', stateLabel))
    .filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact))
    .sort((left, right) => right.id - left.id)[0]

  if (revisionArtifact) {
    try {
      const parsed = parseBeadsCoverageRevisionCandidate(revisionArtifact.content)
      return { candidateContent: parsed.refinedContent, candidateVersion: parsed.candidateVersion }
    } catch { /* ignore */ }
  }

  const refinedArtifact = getLatestPhaseArtifact(ticketId, 'beads_refined', 'REFINING_BEADS')
  if (refinedArtifact) {
    try {
      const { refinedContent } = parseBeadsRefinedArtifact(refinedArtifact.content)
      if (refinedContent.trim()) {
        return { candidateContent: refinedContent, candidateVersion: 1 }
      }
    } catch { /* ignore */ }
  }

  return null
}

function normalizeGaps(gaps: string[]): string[] {
  return gaps.map(gap => gap.trim()).filter((gap): gap is string => gap.length > 0)
}

interface CoverageEnvelopeNormalizationOptions {
  /** Sentence-leading label, e.g. "PRD coverage reported status clean…". */
  label: string
  /** Same label as it reads mid-sentence, e.g. "…empty beads coverage gap strings". */
  trimmedLabel: string
  /**
   * PRD and beads coverage are envelope-only, so follow-up questions are dropped
   * with a warning. Interview coverage is the one phase that asks them.
   */
  followUps: 'ignored' | 'kept'
  /**
   * PRD and beads must name at least one gap when they report gaps. Interview
   * coverage may report gaps and answer them with follow-up questions instead.
   */
  requireGapsWhenGapsStatus: boolean
}

/**
 * One clean/gaps consistency check for all three coverage phases. PRD and beads
 * each had their own copy; interview coverage had none, so an explicit
 * `status: clean` won regardless of the gaps or follow-up questions beside it,
 * and resolveInterviewCoverageFollowUpResolution then dropped every follow-up
 * because the status was not `gaps`.
 */
function normalizeCoverageEnvelope(
  envelope: CoverageResultEnvelope,
  options: CoverageEnvelopeNormalizationOptions,
): {
  envelope: CoverageResultEnvelope
  repairWarnings: string[]
  validationError?: string
} {
  const repairWarnings: string[] = []
  const followUpQuestions = options.followUps === 'kept' ? envelope.followUpQuestions : []

  if (options.followUps === 'ignored' && envelope.followUpQuestions.length > 0) {
    repairWarnings.push(`${options.label} coverage follow_up_questions were ignored because ${options.trimmedLabel} coverage is envelope-only.`)
  }

  const sanitizedGaps = normalizeGaps(envelope.gaps)

  if (envelope.status === 'clean') {
    if (sanitizedGaps.length > 0) {
      return {
        envelope: { status: 'clean', gaps: sanitizedGaps, followUpQuestions },
        repairWarnings,
        validationError: `${options.label} coverage reported status clean but also returned gaps. Return status gaps for unresolved coverage and keep gaps empty when status is clean.`,
      }
    }

    if (followUpQuestions.length > 0) {
      return {
        envelope: { status: 'clean', gaps: [], followUpQuestions },
        repairWarnings,
        validationError: `${options.label} coverage reported status clean but also returned follow-up questions. Return status gaps when follow-up questions are needed, and keep follow_up_questions empty when status is clean.`,
      }
    }

    return {
      envelope: { status: 'clean', gaps: [], followUpQuestions },
      repairWarnings,
    }
  }

  if (options.requireGapsWhenGapsStatus && sanitizedGaps.length === 0) {
    return {
      envelope: { status: 'gaps', gaps: [], followUpQuestions },
      repairWarnings,
      validationError: `${options.label} coverage reported status gaps but did not return any non-empty gap strings. Return at least one concrete gap string.`,
    }
  }

  // Interview coverage is exempt from the rule above because a follow-up question
  // can stand in for a gap string. Neither one is still a `gaps` status naming
  // nothing to resolve, which reads as unresolved coverage forever.
  if (!options.requireGapsWhenGapsStatus && sanitizedGaps.length === 0 && followUpQuestions.length === 0) {
    return {
      envelope: { status: 'gaps', gaps: [], followUpQuestions },
      repairWarnings,
      validationError: `${options.label} coverage reported status gaps but returned neither a gap string nor a follow-up question. Return at least one concrete gap or follow-up question, or report status clean.`,
    }
  }

  if (sanitizedGaps.length !== envelope.gaps.length) {
    repairWarnings.push(`Trimmed empty ${options.trimmedLabel} coverage gap strings before persisting the normalized result.`)
  }

  return {
    envelope: { status: 'gaps', gaps: sanitizedGaps, followUpQuestions },
    repairWarnings,
  }
}

/**
 * Makes a contradictory coverage envelope agree with itself once the structured
 * retries are spent.
 *
 * The status is a label; the gaps and follow-up questions are the evidence. When
 * the two disagree and the model will not fix it, believe the evidence: a `clean`
 * status that lists gaps becomes `gaps` so the follow-up machinery works them,
 * and a `gaps` status naming nothing to resolve becomes `clean`. PRD and beads
 * fail the ticket here instead, because neither has a follow-up mechanism to
 * route the gaps into.
 */
export function reconcileExhaustedCoverageEnvelope(
  envelope: CoverageResultEnvelope,
): { envelope: CoverageResultEnvelope; repairWarning: string } | null {
  const hasEvidence = envelope.gaps.length > 0 || envelope.followUpQuestions.length > 0
  if (envelope.status === 'clean' && hasEvidence) {
    return {
      envelope: { ...envelope, status: 'gaps' },
      repairWarning: 'Interview coverage kept reporting status clean alongside gaps or follow-up questions; read it as status gaps so the reported work is not dropped.',
    }
  }
  if (envelope.status === 'gaps' && !hasEvidence) {
    return {
      envelope: { ...envelope, status: 'clean' },
      repairWarning: 'Interview coverage kept reporting status gaps without naming a gap or a follow-up question; read it as status clean.',
    }
  }
  return null
}

/**
 * The envelope's own YAML. PRD and beads rebuild this whenever they replace the
 * parsed value; interview replaced the value and left the parser's original
 * text, so a companion artifact could carry `status: clean` in its serialized
 * form beside `status: gaps` in its parsed one.
 */
function buildCoverageEnvelopeYaml(envelope: CoverageResultEnvelope): string {
  return buildYamlDocument({
    status: envelope.status,
    gaps: envelope.gaps,
    follow_up_questions: envelope.followUpQuestions,
  })
}

export function normalizePrdCoverageEnvelope(envelope: CoverageResultEnvelope) {
  return normalizeCoverageEnvelope(envelope, {
    label: 'PRD',
    trimmedLabel: 'PRD',
    followUps: 'ignored',
    requireGapsWhenGapsStatus: true,
  })
}

export function normalizeBeadsCoverageEnvelope(envelope: CoverageResultEnvelope) {
  return normalizeCoverageEnvelope(envelope, {
    label: 'Beads',
    trimmedLabel: 'beads',
    followUps: 'ignored',
    requireGapsWhenGapsStatus: true,
  })
}

export function normalizeInterviewCoverageEnvelope(envelope: CoverageResultEnvelope) {
  return normalizeCoverageEnvelope(envelope, {
    label: 'Interview',
    trimmedLabel: 'interview',
    followUps: 'kept',
    // Interview coverage answers its gaps with follow-up questions, so a gaps
    // status with no gap strings is normal here.
    requireGapsWhenGapsStatus: false,
  })
}

async function runPrdCoverageAuditPrompt(params: {
  ticketId: string
  externalId: string
  stateLabel: WorkflowPhaseId
  winnerId: string
  worktreePath: string
  promptContent: string
  councilSettings: ReturnType<typeof resolveCouncilRuntimeSettings>
  coverageRunNumber: number
  maxCoveragePasses: number
  structuredRetryCount: number
  signal: AbortSignal
}): Promise<{
  response: string
  envelope: CoverageResultEnvelope
  normalizedContent: string
  structuredMeta: ReturnType<typeof buildStructuredMetadata>
  rawAttempts: RawAttempt[]
}> {
  throwIfAborted(params.signal, params.ticketId)

  const streamState = createOpenCodeStreamState()
  let sessionId = ''
  let runResult: Awaited<ReturnType<typeof runOpenCodePrompt>> | undefined
  let response = ''
  let coverageEnvelope: ReturnType<typeof normalizeCoverageResultOutput> | null = null
  let promptParts: PromptPart[] = [{ type: 'text', content: params.promptContent }]
  const initialInput = formatPromptText(promptParts)
  let structuredMeta = buildStructuredMetadata({ autoRetryCount: 0, repairApplied: false, repairWarnings: [] })
  const rawAttempts: RawAttempt[] = []
  let latestOpenCodeDiagnostics: OpenCodeDiagnosticResult | null = null

  for (let attempt = 0; attempt <= params.structuredRetryCount; attempt += 1) {
    const diagnosticTracker = createOpenCodeDiagnosticTracker(params.winnerId)
    try {
      runResult = await runOpenCodePrompt({
        adapter,
        projectPath: params.worktreePath,
        parts: promptParts,
        signal: params.signal,
        timeoutMs: params.councilSettings.draftTimeoutMs,
        model: params.winnerId,
        variant: 'coverage',
        erroredSessionPolicy: 'discard_errored_session_output',
        toolPolicy: getCoveragePromptTemplate('prd').toolPolicy,
        sessionOwnership: {
          ticketId: params.ticketId,
          phase: params.stateLabel,
          memberId: params.winnerId,
        },
        onSessionCreated: (session) => {
          sessionId = session.id
          emitAiMilestone(
            params.ticketId,
            params.externalId,
            params.stateLabel,
            `OpenCode coverage: sending prd verification prompt to ${params.winnerId} (session=${session.id}).`,
            `${params.stateLabel}:${session.id}:prd-coverage-audit-created`,
            {
              modelId: params.winnerId,
              sessionId: session.id,
              source: `model:${params.winnerId}`,
            },
          )
        },
        onStreamEvent: (event) => {
          diagnosticTracker.observeStreamEvent(event)
          if (!sessionId) return
          emitOpenCodeStreamEvent(
            params.ticketId,
            params.externalId,
            params.stateLabel,
            params.winnerId,
            sessionId,
            event,
            streamState,
          )
        },
        onPromptDispatched: (event) => {
          emitOpenCodePromptLog(
            params.ticketId,
            params.externalId,
            params.stateLabel,
            params.winnerId,
            event,
          )
        },
      })
    } catch (error) {
      if (error instanceof CancelledError) throw error
      if (error instanceof Error && error.message === 'Timeout') {
        throw new Error('Coverage verification failed: Timeout')
      }
      throwIfCancelled(error, params.signal, params.ticketId)
      throw error
    }

    throwIfAborted(params.signal, params.ticketId)
    response = runResult.response
    const runDiagnostics = diagnosticTracker.build(runResult)
    if (runDiagnostics.diagnostics) {
      latestOpenCodeDiagnostics = runDiagnostics
    }

    emitOpenCodeSessionLogs(
      params.ticketId,
      params.externalId,
      params.stateLabel,
      params.winnerId,
      runResult.session.id,
      'coverage',
      response,
      runResult.messages,
      streamState,
    )

    coverageEnvelope = normalizeCoverageResultOutput(response)
    if (coverageEnvelope.ok) {
      structuredMeta = buildStructuredMetadata(structuredMeta, {
        repairApplied: coverageEnvelope.repairApplied,
        repairWarnings: coverageEnvelope.repairWarnings,
      })

      const prdCoverageNormalization = normalizePrdCoverageEnvelope(coverageEnvelope.value)
      if (prdCoverageNormalization.repairWarnings.length > 0) {
        structuredMeta = buildStructuredMetadata(structuredMeta, {
          repairWarnings: prdCoverageNormalization.repairWarnings,
        })
      }

      if (prdCoverageNormalization.validationError) {
        const retryDecision = getStructuredRetryDecision(response, runResult.responseMeta)
        const rawAttempt = appendRejectedRawAttempt(rawAttempts, {
          stage: 'prd_coverage_audit',
          rawResponse: response,
          initialInput,
          validationError: prdCoverageNormalization.validationError,
          failureClass: retryDecision.failureClass,
        })
        if (attempt >= params.structuredRetryCount) {
          structuredMeta = buildStructuredMetadata(structuredMeta, {
            autoRetryCount: attempt,
            validationError: prdCoverageNormalization.validationError,
            retryDiagnostics: [resolveStructuredRetryDiagnostic({
              attempt: rawAttempt.attempt,
              rawResponse: response,
              validationError: prdCoverageNormalization.validationError,
              failureClass: retryDecision.failureClass,
            })],
          })
          throw errorWithOpenCodeDiagnostics(
            `PRD coverage output failed semantic validation after ${params.structuredRetryCount} structured retry attempt(s): ${prdCoverageNormalization.validationError}`,
            latestOpenCodeDiagnostics,
          )
        }

        structuredMeta = buildStructuredMetadata(structuredMeta, {
          autoRetryCount: attempt + 1,
          validationError: prdCoverageNormalization.validationError,
          retryDiagnostics: [resolveStructuredRetryDiagnostic({
            attempt: rawAttempt.attempt,
            rawResponse: response,
            validationError: prdCoverageNormalization.validationError,
            failureClass: retryDecision.failureClass,
          })],
        })
        promptParts = buildStructuredRetryPrompt([{ type: 'text', content: params.promptContent }], {
          validationError: prdCoverageNormalization.validationError,
          rawResponse: response,
          schemaReminder: getCoveragePromptTemplate('prd').outputFormat,
        })
        continue
      }

      coverageEnvelope = {
        ...coverageEnvelope,
        value: prdCoverageNormalization.envelope,
        normalizedContent: buildYamlDocument({
          status: prdCoverageNormalization.envelope.status,
          gaps: prdCoverageNormalization.envelope.gaps,
          follow_up_questions: prdCoverageNormalization.envelope.followUpQuestions,
        }),
        repairApplied: coverageEnvelope.repairApplied || prdCoverageNormalization.repairWarnings.length > 0,
        repairWarnings: [...coverageEnvelope.repairWarnings, ...prdCoverageNormalization.repairWarnings],
      }
      appendAcceptedRawAttempt(rawAttempts, {
        stage: 'prd_coverage_audit',
        rawResponse: response,
        initialInput,
      })
      break
    }

    const retryDecision = getStructuredRetryDecision(response, runResult.responseMeta)
    const rawAttempt = appendRejectedRawAttempt(rawAttempts, {
      stage: 'prd_coverage_audit',
      rawResponse: response,
      initialInput,
      validationError: coverageEnvelope.error,
      failureClass: retryDecision.failureClass,
    })
    if (attempt >= params.structuredRetryCount) {
      structuredMeta = buildStructuredMetadata(structuredMeta, {
        autoRetryCount: attempt,
        validationError: coverageEnvelope.error,
        retryDiagnostics: [resolveStructuredRetryDiagnostic({
          attempt: rawAttempt.attempt,
          rawResponse: response,
          validationError: coverageEnvelope.error,
          failureClass: retryDecision.failureClass,
          retryDiagnostic: coverageEnvelope.retryDiagnostic,
        })],
      })
      throw errorWithOpenCodeDiagnostics(
        `Coverage output failed validation after ${params.structuredRetryCount} structured retry attempt(s): ${coverageEnvelope.error}`,
        latestOpenCodeDiagnostics,
      )
    }

    structuredMeta = buildStructuredMetadata(structuredMeta, {
      autoRetryCount: attempt + 1,
      validationError: coverageEnvelope.error,
      retryDiagnostics: [resolveStructuredRetryDiagnostic({
        attempt: rawAttempt.attempt,
        rawResponse: response,
        validationError: coverageEnvelope.error,
        failureClass: retryDecision.failureClass,
        retryDiagnostic: coverageEnvelope.retryDiagnostic,
      })],
    })
    promptParts = buildStructuredRetryPrompt([{ type: 'text', content: params.promptContent }], {
      validationError: coverageEnvelope.error,
      rawResponse: response,
      schemaReminder: getCoveragePromptTemplate('prd').outputFormat,
    })
  }

  if (!coverageEnvelope?.ok || !runResult) {
    throw errorWithOpenCodeDiagnostics(
      'Coverage verification finished without a parseable structured result.',
      latestOpenCodeDiagnostics,
    )
  }

  return {
    response,
    envelope: coverageEnvelope.value,
    normalizedContent: coverageEnvelope.normalizedContent,
    structuredMeta,
    rawAttempts,
  }
}

async function runPrdCoverageResolutionPrompt(params: {
  ticketId: string
  externalId: string
  stateLabel: WorkflowPhaseId
  winnerId: string
  worktreePath: string
  promptContent: string
  councilSettings: ReturnType<typeof resolveCouncilRuntimeSettings>
  signal: AbortSignal
  fullAnswersContent: string
  currentCandidateContent: string
  coverageGaps: string[]
  structuredRetryCount: number
}): Promise<{
  response: string
  revision: ReturnType<typeof validatePrdCoverageRevisionOutput>
  structuredMeta: ReturnType<typeof buildStructuredMetadata>
  rawAttempts: RawAttempt[]
}> {
  throwIfAborted(params.signal, params.ticketId)

  const streamState = createOpenCodeStreamState()
  let sessionId = ''
  let response = ''
  let promptParts: PromptPart[] = [{ type: 'text', content: params.promptContent }]
  const initialInput = formatPromptText(promptParts)
  let structuredMeta = buildStructuredMetadata({ autoRetryCount: 0, repairApplied: false, repairWarnings: [] })
  const rawAttempts: RawAttempt[] = []
  let latestOpenCodeDiagnostics: OpenCodeDiagnosticResult | null = null

  for (let attempt = 0; attempt <= params.structuredRetryCount; attempt += 1) {
    let runResult: Awaited<ReturnType<typeof runOpenCodePrompt>>
    const diagnosticTracker = createOpenCodeDiagnosticTracker(params.winnerId)
    try {
      runResult = await runOpenCodePrompt({
        adapter,
        projectPath: params.worktreePath,
        parts: promptParts,
        signal: params.signal,
        timeoutMs: params.councilSettings.draftTimeoutMs,
        model: params.winnerId,
        variant: 'coverage',
        erroredSessionPolicy: 'discard_errored_session_output',
        toolPolicy: PROM13b.toolPolicy,
        sessionOwnership: {
          ticketId: params.ticketId,
          phase: params.stateLabel,
          memberId: params.winnerId,
        },
        onSessionCreated: (session) => {
          sessionId = session.id
          emitAiMilestone(
            params.ticketId,
            params.externalId,
            params.stateLabel,
            `OpenCode coverage: sending PRD coverage resolution prompt to ${params.winnerId} (session=${session.id}).`,
            `${params.stateLabel}:${session.id}:prd-coverage-resolution-created`,
            {
              modelId: params.winnerId,
              sessionId: session.id,
              source: `model:${params.winnerId}`,
            },
          )
        },
        onStreamEvent: (event) => {
          diagnosticTracker.observeStreamEvent(event)
          if (!sessionId) return
          emitOpenCodeStreamEvent(
            params.ticketId,
            params.externalId,
            params.stateLabel,
            params.winnerId,
            sessionId,
            event,
            streamState,
          )
        },
        onPromptDispatched: (event) => {
          emitOpenCodePromptLog(
            params.ticketId,
            params.externalId,
            params.stateLabel,
            params.winnerId,
            event,
          )
        },
      })
    } catch (error) {
      if (error instanceof CancelledError) throw error
      if (error instanceof Error && error.message === 'Timeout') {
        throw new Error('PRD coverage resolution failed: Timeout')
      }
      throwIfCancelled(error, params.signal, params.ticketId)
      throw error
    }

    throwIfAborted(params.signal, params.ticketId)
    response = runResult.response
    const runDiagnostics = diagnosticTracker.build(runResult)
    if (runDiagnostics.diagnostics) {
      latestOpenCodeDiagnostics = runDiagnostics
    }

    emitOpenCodeSessionLogs(
      params.ticketId,
      params.externalId,
      params.stateLabel,
      params.winnerId,
      runResult.session.id,
      'coverage',
      response,
      runResult.messages,
      streamState,
    )

    try {
      const revision = validatePrdCoverageRevisionOutput(response, {
        ticketId: params.externalId,
        interviewContent: params.fullAnswersContent,
        currentCandidateContent: params.currentCandidateContent,
        coverageGaps: params.coverageGaps,
      })

      structuredMeta = buildStructuredMetadata(structuredMeta, {
        repairApplied: revision.repairApplied,
        repairWarnings: revision.repairWarnings,
      })

      appendAcceptedRawAttempt(rawAttempts, {
        stage: 'prd_coverage_revision',
        rawResponse: response,
        initialInput,
      })

      return { response, revision, structuredMeta, rawAttempts }
    } catch (error) {
      const validationError = getErrorMessage(error)
      const retryDecision = getStructuredRetryDecision(response, runResult.responseMeta)
      const rawAttempt = appendRejectedRawAttempt(rawAttempts, {
        stage: 'prd_coverage_revision',
        rawResponse: response,
        initialInput,
        validationError,
        failureClass: retryDecision.failureClass,
      })
      if (attempt >= params.structuredRetryCount) {
        structuredMeta = buildStructuredMetadata(structuredMeta, {
          autoRetryCount: attempt,
          validationError,
          retryDiagnostics: [resolveStructuredRetryDiagnostic({
            attempt: rawAttempt.attempt,
            rawResponse: response,
            validationError,
            failureClass: retryDecision.failureClass,
            error,
          })],
        })
        throw errorWithOpenCodeDiagnostics(
          `PRD coverage resolution output failed validation after ${params.structuredRetryCount} structured retry attempt(s): ${validationError}`,
          latestOpenCodeDiagnostics,
        )
      }

      structuredMeta = buildStructuredMetadata(structuredMeta, {
        autoRetryCount: attempt + 1,
        validationError,
        retryDiagnostics: [resolveStructuredRetryDiagnostic({
          attempt: rawAttempt.attempt,
          rawResponse: response,
          validationError,
          failureClass: retryDecision.failureClass,
          error,
        })],
      })
      promptParts = buildPrdCoverageRevisionRetryPrompt([{ type: 'text', content: params.promptContent }], {
        validationError,
        rawResponse: response,
      })
    }
  }

  throw errorWithOpenCodeDiagnostics(
    'PRD coverage resolution finished without a validated structured result.',
    latestOpenCodeDiagnostics,
  )
}

async function runBeadsCoverageAuditPrompt(params: {
  ticketId: string
  externalId: string
  stateLabel: WorkflowPhaseId
  winnerId: string
  worktreePath: string
  promptContent: string
  councilSettings: ReturnType<typeof resolveCouncilRuntimeSettings>
  signal: AbortSignal
  structuredRetryCount: number
}): Promise<{
  response: string
  envelope: CoverageResultEnvelope
  normalizedContent: string
  structuredMeta: ReturnType<typeof buildStructuredMetadata>
  rawAttempts: RawAttempt[]
}> {
  throwIfAborted(params.signal, params.ticketId)

  const streamState = createOpenCodeStreamState()
  let sessionId = ''
  let runResult: Awaited<ReturnType<typeof runOpenCodePrompt>> | undefined
  let response = ''
  let coverageEnvelope: ReturnType<typeof normalizeCoverageResultOutput> | null = null
  let promptParts: PromptPart[] = [{ type: 'text', content: params.promptContent }]
  const initialInput = formatPromptText(promptParts)
  let structuredMeta = buildStructuredMetadata({ autoRetryCount: 0, repairApplied: false, repairWarnings: [] })
  const rawAttempts: RawAttempt[] = []
  let latestOpenCodeDiagnostics: OpenCodeDiagnosticResult | null = null

  for (let attempt = 0; attempt <= params.structuredRetryCount; attempt += 1) {
    const diagnosticTracker = createOpenCodeDiagnosticTracker(params.winnerId)
    try {
      runResult = await runOpenCodePrompt({
        adapter,
        projectPath: params.worktreePath,
        parts: promptParts,
        signal: params.signal,
        timeoutMs: params.councilSettings.draftTimeoutMs,
        model: params.winnerId,
        variant: 'coverage',
        erroredSessionPolicy: 'discard_errored_session_output',
        toolPolicy: getCoveragePromptTemplate('beads').toolPolicy,
        sessionOwnership: {
          ticketId: params.ticketId,
          phase: params.stateLabel,
          memberId: params.winnerId,
        },
        onSessionCreated: (session) => {
          sessionId = session.id
          emitAiMilestone(
            params.ticketId,
            params.externalId,
            params.stateLabel,
            `OpenCode coverage: sending beads verification prompt to ${params.winnerId} (session=${session.id}).`,
            `${params.stateLabel}:${session.id}:beads-coverage-audit-created`,
            {
              modelId: params.winnerId,
              sessionId: session.id,
              source: `model:${params.winnerId}`,
            },
          )
        },
        onStreamEvent: (event) => {
          diagnosticTracker.observeStreamEvent(event)
          if (!sessionId) return
          emitOpenCodeStreamEvent(
            params.ticketId,
            params.externalId,
            params.stateLabel,
            params.winnerId,
            sessionId,
            event,
            streamState,
          )
        },
        onPromptDispatched: (event) => {
          emitOpenCodePromptLog(
            params.ticketId,
            params.externalId,
            params.stateLabel,
            params.winnerId,
            event,
          )
        },
      })
    } catch (error) {
      if (error instanceof CancelledError) throw error
      if (error instanceof Error && error.message === 'Timeout') {
        throw new Error('Coverage verification failed: Timeout')
      }
      throwIfCancelled(error, params.signal, params.ticketId)
      throw error
    }

    throwIfAborted(params.signal, params.ticketId)
    response = runResult.response
    const runDiagnostics = diagnosticTracker.build(runResult)
    if (runDiagnostics.diagnostics) {
      latestOpenCodeDiagnostics = runDiagnostics
    }

    emitOpenCodeSessionLogs(
      params.ticketId,
      params.externalId,
      params.stateLabel,
      params.winnerId,
      runResult.session.id,
      'coverage',
      response,
      runResult.messages,
      streamState,
    )

    coverageEnvelope = normalizeCoverageResultOutput(response)
    if (coverageEnvelope.ok) {
      structuredMeta = buildStructuredMetadata(structuredMeta, {
        repairApplied: coverageEnvelope.repairApplied,
        repairWarnings: coverageEnvelope.repairWarnings,
      })

      const beadsCoverageNormalization = normalizeBeadsCoverageEnvelope(coverageEnvelope.value)
      if (beadsCoverageNormalization.repairWarnings.length > 0) {
        structuredMeta = buildStructuredMetadata(structuredMeta, {
          repairWarnings: beadsCoverageNormalization.repairWarnings,
        })
      }

      if (beadsCoverageNormalization.validationError) {
        const retryDecision = getStructuredRetryDecision(response, runResult.responseMeta)
        const rawAttempt = appendRejectedRawAttempt(rawAttempts, {
          stage: 'beads_coverage_audit',
          rawResponse: response,
          initialInput,
          validationError: beadsCoverageNormalization.validationError,
          failureClass: retryDecision.failureClass,
        })
        if (attempt >= params.structuredRetryCount) {
          structuredMeta = buildStructuredMetadata(structuredMeta, {
            autoRetryCount: attempt,
            validationError: beadsCoverageNormalization.validationError,
            retryDiagnostics: [resolveStructuredRetryDiagnostic({
              attempt: rawAttempt.attempt,
              rawResponse: response,
              validationError: beadsCoverageNormalization.validationError,
              failureClass: retryDecision.failureClass,
            })],
          })
          throw errorWithOpenCodeDiagnostics(
            `Beads coverage output failed semantic validation after ${params.structuredRetryCount} structured retry attempt(s): ${beadsCoverageNormalization.validationError}`,
            latestOpenCodeDiagnostics,
          )
        }

        structuredMeta = buildStructuredMetadata(structuredMeta, {
          autoRetryCount: attempt + 1,
          validationError: beadsCoverageNormalization.validationError,
          retryDiagnostics: [resolveStructuredRetryDiagnostic({
            attempt: rawAttempt.attempt,
            rawResponse: response,
            validationError: beadsCoverageNormalization.validationError,
            failureClass: retryDecision.failureClass,
          })],
        })
        promptParts = buildStructuredRetryPrompt([{ type: 'text', content: params.promptContent }], {
          validationError: beadsCoverageNormalization.validationError,
          rawResponse: response,
          schemaReminder: getCoveragePromptTemplate('beads').outputFormat,
        })
        continue
      }

      coverageEnvelope = {
        ...coverageEnvelope,
        value: beadsCoverageNormalization.envelope,
        normalizedContent: buildYamlDocument({
          status: beadsCoverageNormalization.envelope.status,
          gaps: beadsCoverageNormalization.envelope.gaps,
          follow_up_questions: beadsCoverageNormalization.envelope.followUpQuestions,
        }),
        repairApplied: coverageEnvelope.repairApplied || beadsCoverageNormalization.repairWarnings.length > 0,
        repairWarnings: [...coverageEnvelope.repairWarnings, ...beadsCoverageNormalization.repairWarnings],
      }
      appendAcceptedRawAttempt(rawAttempts, {
        stage: 'beads_coverage_audit',
        rawResponse: response,
        initialInput,
      })
      break
    }

    const retryDecision = getStructuredRetryDecision(response, runResult.responseMeta)
    const rawAttempt = appendRejectedRawAttempt(rawAttempts, {
      stage: 'beads_coverage_audit',
      rawResponse: response,
      initialInput,
      validationError: coverageEnvelope.error,
      failureClass: retryDecision.failureClass,
    })
    if (attempt >= params.structuredRetryCount) {
      structuredMeta = buildStructuredMetadata(structuredMeta, {
        autoRetryCount: attempt,
        validationError: coverageEnvelope.error,
        retryDiagnostics: [resolveStructuredRetryDiagnostic({
          attempt: rawAttempt.attempt,
          rawResponse: response,
          validationError: coverageEnvelope.error,
          failureClass: retryDecision.failureClass,
          retryDiagnostic: coverageEnvelope.retryDiagnostic,
        })],
      })
      throw errorWithOpenCodeDiagnostics(
        `Coverage output failed validation after ${params.structuredRetryCount} structured retry attempt(s): ${coverageEnvelope.error}`,
        latestOpenCodeDiagnostics,
      )
    }

    structuredMeta = buildStructuredMetadata(structuredMeta, {
      autoRetryCount: attempt + 1,
      validationError: coverageEnvelope.error,
      retryDiagnostics: [resolveStructuredRetryDiagnostic({
        attempt: rawAttempt.attempt,
        rawResponse: response,
        validationError: coverageEnvelope.error,
        failureClass: retryDecision.failureClass,
        retryDiagnostic: coverageEnvelope.retryDiagnostic,
      })],
    })
    promptParts = buildStructuredRetryPrompt([{ type: 'text', content: params.promptContent }], {
      validationError: coverageEnvelope.error,
      rawResponse: response,
      schemaReminder: getCoveragePromptTemplate('beads').outputFormat,
    })
  }

  if (!coverageEnvelope?.ok || !runResult) {
    throw errorWithOpenCodeDiagnostics(
      'Coverage verification finished without a parseable structured result.',
      latestOpenCodeDiagnostics,
    )
  }

  return {
    response,
    envelope: coverageEnvelope.value,
    normalizedContent: coverageEnvelope.normalizedContent,
    structuredMeta,
    rawAttempts,
  }
}

async function runBeadsCoverageResolutionPrompt(params: {
  ticketId: string
  externalId: string
  stateLabel: WorkflowPhaseId
  winnerId: string
  worktreePath: string
  promptContent: string
  councilSettings: ReturnType<typeof resolveCouncilRuntimeSettings>
  signal: AbortSignal
  currentCandidateContent: string
  coverageGaps: string[]
  structuredRetryCount: number
}): Promise<{
  response: string
  revision: ReturnType<typeof validateBeadsCoverageRevisionOutput>
  structuredMeta: ReturnType<typeof buildStructuredMetadata>
  rawAttempts: RawAttempt[]
}> {
  throwIfAborted(params.signal, params.ticketId)

  const streamState = createOpenCodeStreamState()
  let sessionId = ''
  let response = ''
  let promptParts: PromptPart[] = [{ type: 'text', content: params.promptContent }]
  const initialInput = formatPromptText(promptParts)
  let structuredMeta = buildStructuredMetadata({ autoRetryCount: 0, repairApplied: false, repairWarnings: [] })
  const rawAttempts: RawAttempt[] = []
  let latestOpenCodeDiagnostics: OpenCodeDiagnosticResult | null = null

  for (let attempt = 0; attempt <= params.structuredRetryCount; attempt += 1) {
    let runResult: Awaited<ReturnType<typeof runOpenCodePrompt>>
    const diagnosticTracker = createOpenCodeDiagnosticTracker(params.winnerId)
    try {
      runResult = await runOpenCodePrompt({
        adapter,
        projectPath: params.worktreePath,
        parts: promptParts,
        signal: params.signal,
        timeoutMs: params.councilSettings.draftTimeoutMs,
        model: params.winnerId,
        variant: 'coverage',
        erroredSessionPolicy: 'discard_errored_session_output',
        toolPolicy: PROM24.toolPolicy,
        sessionOwnership: {
          ticketId: params.ticketId,
          phase: params.stateLabel,
          memberId: params.winnerId,
        },
        onSessionCreated: (session) => {
          sessionId = session.id
          emitAiMilestone(
            params.ticketId,
            params.externalId,
            params.stateLabel,
            `OpenCode coverage: sending beads coverage resolution prompt to ${params.winnerId} (session=${session.id}).`,
            `${params.stateLabel}:${session.id}:beads-coverage-resolution-created`,
            {
              modelId: params.winnerId,
              sessionId: session.id,
              source: `model:${params.winnerId}`,
            },
          )
        },
        onStreamEvent: (event) => {
          diagnosticTracker.observeStreamEvent(event)
          if (!sessionId) return
          emitOpenCodeStreamEvent(
            params.ticketId,
            params.externalId,
            params.stateLabel,
            params.winnerId,
            sessionId,
            event,
            streamState,
          )
        },
        onPromptDispatched: (event) => {
          emitOpenCodePromptLog(
            params.ticketId,
            params.externalId,
            params.stateLabel,
            params.winnerId,
            event,
          )
        },
      })
    } catch (error) {
      if (error instanceof CancelledError) throw error
      if (error instanceof Error && error.message === 'Timeout') {
        throw new Error('Beads coverage resolution failed: Timeout')
      }
      throwIfCancelled(error, params.signal, params.ticketId)
      throw error
    }

    throwIfAborted(params.signal, params.ticketId)
    response = runResult.response
    const runDiagnostics = diagnosticTracker.build(runResult)
    if (runDiagnostics.diagnostics) {
      latestOpenCodeDiagnostics = runDiagnostics
    }

    emitOpenCodeSessionLogs(
      params.ticketId,
      params.externalId,
      params.stateLabel,
      params.winnerId,
      runResult.session.id,
      'coverage',
      response,
      runResult.messages,
      streamState,
    )

    try {
      const revision = validateBeadsCoverageRevisionOutput(response, {
        currentCandidateContent: params.currentCandidateContent,
        coverageGaps: params.coverageGaps,
      })

      structuredMeta = buildStructuredMetadata(structuredMeta, {
        repairApplied: revision.repairApplied,
        repairWarnings: revision.repairWarnings,
      })

      appendAcceptedRawAttempt(rawAttempts, {
        stage: 'beads_coverage_revision',
        rawResponse: response,
        initialInput,
      })

      return { response, revision, structuredMeta, rawAttempts }
    } catch (error) {
      const validationError = getErrorMessage(error)
      const retryDecision = getStructuredRetryDecision(response, runResult.responseMeta)
      const rawAttempt = appendRejectedRawAttempt(rawAttempts, {
        stage: 'beads_coverage_revision',
        rawResponse: response,
        initialInput,
        validationError,
        failureClass: retryDecision.failureClass,
      })
      if (attempt >= params.structuredRetryCount) {
        structuredMeta = buildStructuredMetadata(structuredMeta, {
          autoRetryCount: attempt,
          validationError,
          retryDiagnostics: [resolveStructuredRetryDiagnostic({
            attempt: rawAttempt.attempt,
            rawResponse: response,
            validationError,
            failureClass: retryDecision.failureClass,
            error,
          })],
        })
        throw errorWithOpenCodeDiagnostics(
          `Beads coverage resolution output failed validation after ${params.structuredRetryCount} structured retry attempt(s): ${validationError}`,
          latestOpenCodeDiagnostics,
        )
      }

      structuredMeta = buildStructuredMetadata(structuredMeta, {
        autoRetryCount: attempt + 1,
        validationError,
        retryDiagnostics: [resolveStructuredRetryDiagnostic({
          attempt: rawAttempt.attempt,
          rawResponse: response,
          validationError,
          failureClass: retryDecision.failureClass,
          error,
        })],
      })
      promptParts = buildBeadsCoverageRevisionRetryPrompt([{ type: 'text', content: params.promptContent }], {
        validationError,
        rawResponse: response,
      })
    }
  }

  throw errorWithOpenCodeDiagnostics(
    'Beads coverage resolution finished without a validated structured result.',
    latestOpenCodeDiagnostics,
  )
}

async function finalizeBeadsCoverageExpansion(params: {
  ticketId: string
  externalId: string
  stateLabel: WorkflowPhaseId
  winnerId: string
  worktreePath: string
  signal: AbortSignal
  councilSettings: ReturnType<typeof resolveCouncilRuntimeSettings>
  ticketState: TicketState
  candidateContent: string
  candidateVersion: number
  structuredRetryCount: number
}) {
  const normalizedBlueprint = normalizeBeadSubsetYamlOutput(params.candidateContent)
  if (!normalizedBlueprint.ok) {
    throw new Error(`Final beads expansion requires a valid semantic blueprint: ${normalizedBlueprint.error}`)
  }

  const beadSubsets = normalizedBlueprint.value
  const draftMetrics = getRefinementBeadMetrics(beadSubsets)
  const streamStates = new Map<string, OpenCodeStreamState>()

  emitModelSystemLog(
    params.ticketId,
    params.externalId,
    params.stateLabel,
    'info',
    `Coverage finished for Implementation Plan v${params.candidateVersion}. Running the final expansion step on the validated semantic blueprint.`,
    params.winnerId,
  )

  const expansionResult = await executeBeadsExpandStep({
    ticketId: params.ticketId,
    externalId: params.externalId,
    phaseLabel: params.stateLabel,
    worktreePath: params.worktreePath,
    winnerId: params.winnerId,
    externalRef: params.externalId,
    timeoutMs: params.councilSettings.draftTimeoutMs,
    signal: params.signal,
    ticketState: {
      ...params.ticketState,
      beadsDraft: params.candidateContent,
    },
    beadSubsets,
    maxStructuredRetries: params.structuredRetryCount,
    variant: 'coverage',
    onSessionLog: (entry) => {
      const streamState = streamStates.get(entry.sessionId) ?? createOpenCodeStreamState()
      streamStates.set(entry.sessionId, streamState)
      emitOpenCodeSessionLogs(
        params.ticketId,
        params.externalId,
        params.stateLabel,
        entry.memberId,
        entry.sessionId,
        'coverage',
        entry.response,
        entry.messages,
        streamState,
      )
    },
    onStreamEvent: (entry) => {
      const streamState = streamStates.get(entry.sessionId) ?? createOpenCodeStreamState()
      streamStates.set(entry.sessionId, streamState)
      emitOpenCodeStreamEvent(
        params.ticketId,
        params.externalId,
        params.stateLabel,
        entry.memberId,
        entry.sessionId,
        entry.event,
        streamState,
      )
    },
    onPromptDispatched: (entry) => {
      emitOpenCodePromptLog(
        params.ticketId,
        params.externalId,
        params.stateLabel,
        entry.memberId,
        entry.event,
      )
    },
  })

  insertPhaseArtifact(params.ticketId, {
    phase: params.stateLabel,
    artifactType: 'beads_expanded',
    content: JSON.stringify({
      winnerId: params.winnerId,
      semanticPlanContent: params.candidateContent,
      refinedContent: expansionResult.hydratedContent,
      expandedContent: expansionResult.expandedModelContent,
      candidateVersion: params.candidateVersion,
    }),
  })
  persistUiArtifactCompanionArtifact(params.ticketId, params.stateLabel, 'beads_expanded', {
    structuredOutput: expansionResult.structuredMeta,
    draftMetrics,
    pipelineSteps: BEADS_PIPELINE_STEPS,
    candidateVersion: params.candidateVersion,
  })

  writeTicketBeads(params.ticketId, expansionResult.hydratedBeads)
  updateTicketProgressFromBeads(params.ticketId, expansionResult.hydratedBeads)
  clearContextCache(params.externalId)

  emitModelSystemLog(
    params.ticketId,
    params.externalId,
    params.stateLabel,
    'info',
    `Final beads expansion completed for Implementation Plan v${params.candidateVersion}. Persisted ${expansionResult.hydratedBeads.length} execution-ready beads.`,
    params.winnerId,
  )
}

async function handlePrdCoverageVerificationLoop(params: {
  ticketId: string
  context: TicketContext
  sendEvent: (event: TicketEvent) => void
  signal: AbortSignal
  worktreePath: string
  ticketDir: string
  winnerId: string
  stateLabel: WorkflowPhaseId
  ticketState: TicketState
  effectivePrdContent: string
  fullAnswersContent: string
  councilSettings: ReturnType<typeof resolveCouncilRuntimeSettings>
  coverageSettings: ReturnType<typeof resolveCoverageRuntimeSettings>
}) {
  const prdPath = resolve(params.ticketDir, 'prd.yaml')
  let currentCandidateContent = params.effectivePrdContent.trim()
  const historySnapshot = loadCoverageHistorySnapshot(params.ticketId, 'prd', params.stateLabel)
  const maxCoveragePasses = getVersionedCoveragePassLimit('prd', params.coverageSettings.maxPrdCoveragePasses)
  let attempts = [...historySnapshot.attempts]
  let transitions = [...historySnapshot.transitions]
  let currentCandidateVersion = historySnapshot.finalCandidateVersion
    ?? (countPhaseArtifacts(params.ticketId, 'prd_coverage_revision', params.stateLabel) + 1)

  while (true) {
    const completedCoveragePasses = attempts.length
    const coverageRunState = resolveCoverageRunState(completedCoveragePasses, maxCoveragePasses)
    if (coverageRunState.limitAlreadyReached) {
      emitPhaseLog(
        params.ticketId,
        params.context.externalId,
        params.stateLabel,
        'info',
        `Coverage retry cap already reached for prd (${completedCoveragePasses}/${maxCoveragePasses}). Routing to approval without another coverage execution.`,
      )
      params.sendEvent({ type: 'COVERAGE_LIMIT_REACHED' })
      return
    }

    const { coverageRunNumber, isFinalAllowedRun } = coverageRunState
    params.ticketState.prd = currentCandidateContent
    clearContextCache(params.context.externalId)

    const coverageContext = buildMinimalContext('prd_coverage', params.ticketState)
    const coveragePromptConfiguration = buildCoveragePromptConfiguration({
      phase: 'prd',
      coverageRunNumber,
      maxCoveragePasses,
      isFinalAllowedRun,
    })
    const auditPromptContent = buildPromptFromTemplate(
      getCoveragePromptTemplate('prd'),
      [...coverageContext, coveragePromptConfiguration],
    )

    const auditResult = await runPrdCoverageAuditPrompt({
      ticketId: params.ticketId,
      externalId: params.context.externalId,
      stateLabel: params.stateLabel,
      winnerId: params.winnerId,
      worktreePath: params.worktreePath,
      promptContent: auditPromptContent,
      councilSettings: params.councilSettings,
      coverageRunNumber,
      maxCoveragePasses,
      structuredRetryCount: resolveStructuredRetryRuntimeSettings(params.context).structuredRetryCount,
      signal: params.signal,
    })

    insertPhaseArtifact(params.ticketId, {
      phase: params.stateLabel,
      artifactType: 'prd_coverage_input',
      content: JSON.stringify({
        candidateVersion: currentCandidateVersion,
        refinedContent: currentCandidateContent,
      }),
    })
    persistUiArtifactCompanionArtifact(params.ticketId, params.stateLabel, 'prd_coverage_input', {
      ...(params.ticketState.fullAnswers?.[0] ? { fullAnswers: params.ticketState.fullAnswers[0] } : {}),
      prd: currentCandidateContent,
      refinedContent: currentCandidateContent,
      candidateVersion: currentCandidateVersion,
    })

    const detectedGaps = auditResult.envelope.status === 'gaps'
    const gapDisposition = resolveCoverageGapDisposition({
      phase: 'prd',
      hasGaps: detectedGaps,
      isFinalAllowedRun,
      hasFollowUpQuestions: false,
      remainingInterviewBudget: undefined,
    })
    const attemptEntry: CoverageAttemptHistoryEntry = {
      candidateVersion: currentCandidateVersion,
      status: auditResult.envelope.status,
      summary: buildCoverageAttemptSummary({
        phase: 'prd',
        status: auditResult.envelope.status,
        candidateVersion: currentCandidateVersion,
        gaps: auditResult.envelope.gaps,
        remaining: detectedGaps,
      }),
      gaps: [...auditResult.envelope.gaps],
      auditNotes: auditResult.normalizedContent,
      response: auditResult.response,
      normalizedContent: auditResult.normalizedContent,
      structuredOutput: auditResult.structuredMeta,
      rawAttempts: auditResult.rawAttempts,
      coverageRunNumber,
      maxCoveragePasses,
      limitReached: gapDisposition.limitReached,
      terminationReason: gapDisposition.terminationReason ?? null,
    }
    const nextAttempts = [...attempts, attemptEntry]

    if (!detectedGaps) {
      persistVersionedCoverageArtifact({
        ticketId: params.ticketId,
        stateLabel: params.stateLabel,
        phase: 'prd',
        winnerId: params.winnerId,
        response: auditResult.response,
        normalizedContent: auditResult.normalizedContent,
        parsed: auditResult.envelope,
        structuredOutput: auditResult.structuredMeta,
        attemptEntry,
        attempts: nextAttempts,
        transitions,
        coverageRunNumber,
        maxCoveragePasses,
        limitReached: false,
        terminationReason: gapDisposition.terminationReason,
        finalCandidateVersion: currentCandidateVersion,
        hasRemainingGaps: false,
        remainingGaps: [],
      })
      attempts = nextAttempts
      emitModelSystemLog(
        params.ticketId,
        params.context.externalId,
        params.stateLabel,
        'info',
        `Coverage verification passed (winning model: ${params.winnerId}) for PRD Candidate v${currentCandidateVersion}.`,
        params.winnerId,
      )
      params.sendEvent({ type: 'COVERAGE_CLEAN' })
      return
    }

    if (!gapDisposition.shouldLoopBack) {
      persistVersionedCoverageArtifact({
        ticketId: params.ticketId,
        stateLabel: params.stateLabel,
        phase: 'prd',
        winnerId: params.winnerId,
        response: auditResult.response,
        normalizedContent: auditResult.normalizedContent,
        parsed: auditResult.envelope,
        structuredOutput: auditResult.structuredMeta,
        attemptEntry,
        attempts: nextAttempts,
        transitions,
        coverageRunNumber,
        maxCoveragePasses,
        limitReached: gapDisposition.limitReached,
        terminationReason: gapDisposition.terminationReason,
        finalCandidateVersion: currentCandidateVersion,
        hasRemainingGaps: true,
        remainingGaps: auditResult.envelope.gaps,
      })
      attempts = nextAttempts
      const reviewReason = `Coverage gaps detected by winning model ${params.winnerId}, but ${describeCoverageTerminationReason(gapDisposition.terminationReason)}. Routing to approval with unresolved gaps for manual review.`
      emitModelSystemLog(
        params.ticketId,
        params.context.externalId,
        params.stateLabel,
        'info',
        reviewReason,
        params.winnerId,
      )
      params.sendEvent({ type: 'COVERAGE_LIMIT_REACHED' })
      return
    }

    emitModelSystemLog(
      params.ticketId,
      params.context.externalId,
      params.stateLabel,
      'info',
      `Coverage found ${auditResult.envelope.gaps.length} gap(s) in PRD Candidate v${currentCandidateVersion}. Revising candidate before the next audit pass.`,
      params.winnerId,
    )

    params.ticketState.prd = currentCandidateContent
    clearContextCache(params.context.externalId)
    const revisionContext = buildMinimalContext('prd_coverage', params.ticketState)
    const revisionPromptContent = buildPromptFromTemplate(PROM13b, [
      ...revisionContext,
      {
        type: 'text',
        source: 'coverage_gaps',
        content: buildYamlDocument({ gaps: auditResult.envelope.gaps }),
      },
    ])

    const revisionRun = await runPrdCoverageResolutionPrompt({
      ticketId: params.ticketId,
      externalId: params.context.externalId,
      stateLabel: params.stateLabel,
      winnerId: params.winnerId,
      worktreePath: params.worktreePath,
      promptContent: revisionPromptContent,
      councilSettings: params.councilSettings,
      signal: params.signal,
      fullAnswersContent: params.fullAnswersContent,
      currentCandidateContent,
      coverageGaps: auditResult.envelope.gaps,
      structuredRetryCount: resolveStructuredRetryRuntimeSettings(params.context).structuredRetryCount,
    })

    const nextCandidateVersion = currentCandidateVersion + 1
    const revisionArtifact = buildPrdCoverageRevisionArtifact(
      params.winnerId,
      nextCandidateVersion,
      revisionRun.revision,
      revisionRun.structuredMeta,
    )
    const uiDiffArtifact = buildPrdCoverageRevisionUiDiff(revisionArtifact)

    insertPhaseArtifact(params.ticketId, {
      phase: params.stateLabel,
      artifactType: 'prd_coverage_revision',
      content: JSON.stringify({
        winnerId: revisionArtifact.winnerId,
        refinedContent: revisionArtifact.refinedContent,
        candidateVersion: revisionArtifact.candidateVersion,
        rawAttempts: revisionRun.rawAttempts,
      }),
    })
    persistUiArtifactCompanionArtifact(params.ticketId, params.stateLabel, 'prd_coverage_revision', {
      winnerId: revisionArtifact.winnerId,
      candidateVersion: revisionArtifact.candidateVersion,
      beforeContent: revisionArtifact.winnerDraftContent,
      afterContent: revisionArtifact.refinedContent,
      winnerDraftContent: revisionArtifact.winnerDraftContent,
      refinedContent: revisionArtifact.refinedContent,
      changes: revisionArtifact.changes,
      gapResolutions: revisionArtifact.gapResolutions,
      draftMetrics: revisionArtifact.draftMetrics,
      structuredOutput: revisionArtifact.structuredOutput ?? null,
      uiRefinementDiff: uiDiffArtifact,
      coverageBaselineContent: revisionArtifact.winnerDraftContent,
      coverageBaselineVersion: currentCandidateVersion,
      coverageUiRefinementDiff: uiDiffArtifact,
      rawAttempts: revisionRun.rawAttempts,
    })

    const nextTransitions = [
      ...transitions,
      {
        fromVersion: currentCandidateVersion,
        toVersion: nextCandidateVersion,
        summary: buildCoverageTransitionSummary({
          phase: 'prd',
          fromVersion: currentCandidateVersion,
          toVersion: nextCandidateVersion,
          gaps: auditResult.envelope.gaps,
        }),
        gaps: [...auditResult.envelope.gaps],
        auditNotes: auditResult.normalizedContent,
        fromContent: currentCandidateContent,
        toContent: revisionArtifact.refinedContent,
        gapResolutions: revisionArtifact.gapResolutions,
        resolutionNotes: revisionArtifact.gapResolutions.map((resolution) => resolution.rationale),
        uiRefinementDiff: uiDiffArtifact,
        structuredOutput: revisionRun.structuredMeta,
        rawAttempts: revisionRun.rawAttempts,
      } satisfies CoverageTransitionHistoryEntry,
    ]

    persistVersionedCoverageArtifact({
      ticketId: params.ticketId,
      stateLabel: params.stateLabel,
      phase: 'prd',
      winnerId: params.winnerId,
      response: auditResult.response,
      normalizedContent: auditResult.normalizedContent,
      parsed: auditResult.envelope,
      structuredOutput: auditResult.structuredMeta,
      attemptEntry,
      attempts: nextAttempts,
      transitions: nextTransitions,
      coverageRunNumber,
      maxCoveragePasses,
      limitReached: gapDisposition.limitReached,
      terminationReason: gapDisposition.terminationReason,
      finalCandidateVersion: nextCandidateVersion,
      hasRemainingGaps: true,
      remainingGaps: auditResult.envelope.gaps,
    })

    safeAtomicWrite(prdPath, revisionArtifact.refinedContent)
    clearContextCache(params.context.externalId)

    if (revisionRun.revision.repairWarnings.length > 0) {
      emitModelSystemLog(
        params.ticketId,
        params.context.externalId,
        params.stateLabel,
        'info',
        `PRD coverage resolution normalization applied repairs: ${revisionRun.revision.repairWarnings.join(' | ')}`,
        params.winnerId,
      )
    }
    if ((revisionRun.structuredMeta.autoRetryCount ?? 0) > 0 && revisionRun.structuredMeta.validationError) {
      emitModelSystemLog(
        params.ticketId,
        params.context.externalId,
        params.stateLabel,
        'info',
        `PRD coverage resolution required ${revisionRun.structuredMeta.autoRetryCount} structured retry attempt(s): ${revisionRun.structuredMeta.validationError}`,
        params.winnerId,
      )
    }

    emitModelSystemLog(
      params.ticketId,
      params.context.externalId,
      params.stateLabel,
      'info',
      `Revised PRD Candidate v${currentCandidateVersion} into PRD Candidate v${nextCandidateVersion} and saved it to ${prdPath}.`,
      params.winnerId,
    )

    attempts = nextAttempts
    transitions = nextTransitions
    currentCandidateContent = revisionArtifact.refinedContent
    currentCandidateVersion = nextCandidateVersion
  }
}

async function handleBeadsCoverageVerificationLoop(params: {
  ticketId: string
  context: TicketContext
  sendEvent: (event: TicketEvent) => void
  signal: AbortSignal
  worktreePath: string
  winnerId: string
  stateLabel: WorkflowPhaseId
  ticketState: TicketState
  effectivePrdContent: string
  effectiveBeadsContent: string
  councilSettings: ReturnType<typeof resolveCouncilRuntimeSettings>
  coverageSettings: ReturnType<typeof resolveCoverageRuntimeSettings>
}) {
  let currentCandidateContent = params.effectiveBeadsContent.trim()
  const historySnapshot = loadCoverageHistorySnapshot(params.ticketId, 'beads', params.stateLabel)
  const maxCoveragePasses = getVersionedCoveragePassLimit('beads', params.coverageSettings.maxBeadsCoveragePasses)
  let attempts = [...historySnapshot.attempts]
  let transitions = [...historySnapshot.transitions]
  let currentCandidateVersion = historySnapshot.finalCandidateVersion
    ?? (countPhaseArtifacts(params.ticketId, 'beads_coverage_revision', params.stateLabel) + 1)

  while (true) {
    const completedCoveragePasses = attempts.length
    const coverageRunState = resolveCoverageRunState(completedCoveragePasses, maxCoveragePasses)
    if (coverageRunState.limitAlreadyReached) {
      emitPhaseLog(
        params.ticketId,
        params.context.externalId,
        params.stateLabel,
        'info',
        `Coverage retry cap already reached for beads (${completedCoveragePasses}/${maxCoveragePasses}). Routing to approval with limit already reached.`,
      )
      params.sendEvent({ type: 'COVERAGE_LIMIT_REACHED' })
      return
    }

    const { coverageRunNumber, isFinalAllowedRun } = coverageRunState
    params.ticketState.prd = params.effectivePrdContent
    params.ticketState.beads = currentCandidateContent
    clearContextCache(params.context.externalId)

    const coverageContext = buildMinimalContext('beads_coverage', params.ticketState)
    const coveragePromptConfiguration = buildCoveragePromptConfiguration({
      phase: 'beads',
      coverageRunNumber,
      maxCoveragePasses,
      isFinalAllowedRun,
    })
    const auditPromptContent = buildPromptFromTemplate(
      getCoveragePromptTemplate('beads'),
      [...coverageContext, coveragePromptConfiguration],
    )

    const auditResult = await runBeadsCoverageAuditPrompt({
      ticketId: params.ticketId,
      externalId: params.context.externalId,
      stateLabel: params.stateLabel,
      winnerId: params.winnerId,
      worktreePath: params.worktreePath,
      promptContent: auditPromptContent,
      councilSettings: params.councilSettings,
      structuredRetryCount: resolveStructuredRetryRuntimeSettings(params.context).structuredRetryCount,
      signal: params.signal,
    })

    insertPhaseArtifact(params.ticketId, {
      phase: params.stateLabel,
      artifactType: 'beads_coverage_input',
      content: JSON.stringify({
        candidateVersion: currentCandidateVersion,
        refinedContent: currentCandidateContent,
      }),
    })
    persistUiArtifactCompanionArtifact(params.ticketId, params.stateLabel, 'beads_coverage_input', {
      prd: params.effectivePrdContent,
      beads: currentCandidateContent,
      refinedContent: currentCandidateContent,
      candidateVersion: currentCandidateVersion,
    })

    const detectedGaps = auditResult.envelope.status === 'gaps'
    const gapDisposition = resolveCoverageGapDisposition({
      phase: 'beads',
      hasGaps: detectedGaps,
      isFinalAllowedRun,
      hasFollowUpQuestions: false,
      remainingInterviewBudget: undefined,
    })
    const attemptEntry: CoverageAttemptHistoryEntry = {
      candidateVersion: currentCandidateVersion,
      status: auditResult.envelope.status,
      summary: buildCoverageAttemptSummary({
        phase: 'beads',
        status: auditResult.envelope.status,
        candidateVersion: currentCandidateVersion,
        gaps: auditResult.envelope.gaps,
        remaining: detectedGaps,
      }),
      gaps: [...auditResult.envelope.gaps],
      auditNotes: auditResult.normalizedContent,
      response: auditResult.response,
      normalizedContent: auditResult.normalizedContent,
      structuredOutput: auditResult.structuredMeta,
      rawAttempts: auditResult.rawAttempts,
      coverageRunNumber,
      maxCoveragePasses,
      limitReached: gapDisposition.limitReached,
      terminationReason: gapDisposition.terminationReason ?? null,
    }
    const nextAttempts = [...attempts, attemptEntry]

    if (!detectedGaps) {
      persistVersionedCoverageArtifact({
        ticketId: params.ticketId,
        stateLabel: params.stateLabel,
        phase: 'beads',
        winnerId: params.winnerId,
        response: auditResult.response,
        normalizedContent: auditResult.normalizedContent,
        parsed: auditResult.envelope,
        structuredOutput: auditResult.structuredMeta,
        attemptEntry,
        attempts: nextAttempts,
        transitions,
        coverageRunNumber,
        maxCoveragePasses,
        limitReached: false,
        terminationReason: gapDisposition.terminationReason,
        finalCandidateVersion: currentCandidateVersion,
        hasRemainingGaps: false,
        remainingGaps: [],
      })
      attempts = nextAttempts
      emitModelSystemLog(
        params.ticketId,
        params.context.externalId,
        params.stateLabel,
        'info',
        `Coverage verification passed (winning model: ${params.winnerId}) for Implementation Plan v${currentCandidateVersion}.`,
        params.winnerId,
      )
      params.sendEvent({ type: 'COVERAGE_CLEAN' })
      return
    }

    if (!gapDisposition.shouldLoopBack) {
      persistVersionedCoverageArtifact({
        ticketId: params.ticketId,
        stateLabel: params.stateLabel,
        phase: 'beads',
        winnerId: params.winnerId,
        response: auditResult.response,
        normalizedContent: auditResult.normalizedContent,
        parsed: auditResult.envelope,
        structuredOutput: auditResult.structuredMeta,
        attemptEntry,
        attempts: nextAttempts,
        transitions,
        coverageRunNumber,
        maxCoveragePasses,
        limitReached: gapDisposition.limitReached,
        terminationReason: gapDisposition.terminationReason,
        finalCandidateVersion: currentCandidateVersion,
        hasRemainingGaps: true,
        remainingGaps: auditResult.envelope.gaps,
      })
      attempts = nextAttempts
      const reviewReason = `Coverage gaps detected by winning model ${params.winnerId}, but ${describeCoverageTerminationReason(gapDisposition.terminationReason)}. Routing to approval with unresolved gaps for manual review.`
      emitModelSystemLog(
        params.ticketId,
        params.context.externalId,
        params.stateLabel,
        'info',
        reviewReason,
        params.winnerId,
      )
      params.sendEvent({ type: 'COVERAGE_LIMIT_REACHED' })
      return
    }

    emitModelSystemLog(
      params.ticketId,
      params.context.externalId,
      params.stateLabel,
      'info',
      `Coverage found ${auditResult.envelope.gaps.length} gap(s) in Implementation Plan v${currentCandidateVersion}. Revising candidate before the next audit pass.`,
      params.winnerId,
    )

    params.ticketState.prd = params.effectivePrdContent
    params.ticketState.beads = currentCandidateContent
    clearContextCache(params.context.externalId)
    const revisionContext = buildMinimalContext('beads_coverage', params.ticketState)
    const revisionPromptContent = buildPromptFromTemplate(PROM24, [
      ...revisionContext,
      {
        type: 'text',
        source: 'coverage_gaps',
        content: buildYamlDocument({ gaps: auditResult.envelope.gaps }),
      },
    ])

    const revisionRun = await runBeadsCoverageResolutionPrompt({
      ticketId: params.ticketId,
      externalId: params.context.externalId,
      stateLabel: params.stateLabel,
      winnerId: params.winnerId,
      worktreePath: params.worktreePath,
      promptContent: revisionPromptContent,
      councilSettings: params.councilSettings,
      signal: params.signal,
      currentCandidateContent,
      coverageGaps: auditResult.envelope.gaps,
      structuredRetryCount: resolveStructuredRetryRuntimeSettings(params.context).structuredRetryCount,
    })

    const nextCandidateVersion = currentCandidateVersion + 1
    const revisionArtifact = buildBeadsCoverageRevisionArtifact(
      params.winnerId,
      nextCandidateVersion,
      revisionRun.revision,
      revisionRun.structuredMeta,
      params.effectivePrdContent,
    )

    insertPhaseArtifact(params.ticketId, {
      phase: params.stateLabel,
      artifactType: 'beads_coverage_revision',
      content: JSON.stringify({
        winnerId: revisionArtifact.winnerId,
        refinedContent: revisionArtifact.refinedContent,
        candidateVersion: revisionArtifact.candidateVersion,
        rawAttempts: revisionRun.rawAttempts,
      }),
    })
    persistUiArtifactCompanionArtifact(params.ticketId, params.stateLabel, 'beads_coverage_revision', {
      winnerId: revisionArtifact.winnerId,
      candidateVersion: revisionArtifact.candidateVersion,
      beforeContent: revisionArtifact.winnerDraftContent,
      afterContent: revisionArtifact.refinedContent,
      winnerDraftContent: revisionArtifact.winnerDraftContent,
      refinedContent: revisionArtifact.refinedContent,
      changes: revisionArtifact.changes,
      gapResolutions: revisionArtifact.gapResolutions,
      draftMetrics: revisionArtifact.draftMetrics,
      structuredOutput: revisionArtifact.structuredOutput ?? null,
      uiRefinementDiff: revisionArtifact.uiRefinementDiff,
      coverageBaselineContent: revisionArtifact.winnerDraftContent,
      coverageBaselineVersion: currentCandidateVersion,
      coverageUiRefinementDiff: revisionArtifact.uiRefinementDiff,
      rawAttempts: revisionRun.rawAttempts,
    })

    const nextTransitions = [
      ...transitions,
      {
        fromVersion: currentCandidateVersion,
        toVersion: nextCandidateVersion,
        summary: buildCoverageTransitionSummary({
          phase: 'beads',
          fromVersion: currentCandidateVersion,
          toVersion: nextCandidateVersion,
          gaps: auditResult.envelope.gaps,
        }),
        gaps: [...auditResult.envelope.gaps],
        auditNotes: auditResult.normalizedContent,
        fromContent: currentCandidateContent,
        toContent: revisionArtifact.refinedContent,
        gapResolutions: revisionArtifact.gapResolutions,
        resolutionNotes: revisionArtifact.gapResolutions.map((resolution) => resolution.rationale),
        uiRefinementDiff: revisionArtifact.uiRefinementDiff,
        structuredOutput: revisionRun.structuredMeta,
        rawAttempts: revisionRun.rawAttempts,
      } satisfies CoverageTransitionHistoryEntry,
    ]

    persistVersionedCoverageArtifact({
      ticketId: params.ticketId,
      stateLabel: params.stateLabel,
      phase: 'beads',
      winnerId: params.winnerId,
      response: auditResult.response,
      normalizedContent: auditResult.normalizedContent,
      parsed: auditResult.envelope,
      structuredOutput: auditResult.structuredMeta,
      attemptEntry,
      attempts: nextAttempts,
      transitions: nextTransitions,
      coverageRunNumber,
      maxCoveragePasses,
      limitReached: gapDisposition.limitReached,
      terminationReason: gapDisposition.terminationReason,
      finalCandidateVersion: nextCandidateVersion,
      hasRemainingGaps: true,
      remainingGaps: auditResult.envelope.gaps,
    })
    clearContextCache(params.context.externalId)

    if (revisionRun.revision.repairWarnings.length > 0) {
      emitModelSystemLog(
        params.ticketId,
        params.context.externalId,
        params.stateLabel,
        'info',
        `Beads coverage resolution normalization applied repairs: ${revisionRun.revision.repairWarnings.join(' | ')}`,
        params.winnerId,
      )
    }
    if ((revisionRun.structuredMeta.autoRetryCount ?? 0) > 0 && revisionRun.structuredMeta.validationError) {
      emitModelSystemLog(
        params.ticketId,
        params.context.externalId,
        params.stateLabel,
        'info',
        `Beads coverage resolution required ${revisionRun.structuredMeta.autoRetryCount} structured retry attempt(s): ${revisionRun.structuredMeta.validationError}`,
        params.winnerId,
      )
    }

    emitModelSystemLog(
      params.ticketId,
      params.context.externalId,
      params.stateLabel,
      'info',
      `Revised Implementation Plan v${currentCandidateVersion} into Implementation Plan v${nextCandidateVersion}.`,
      params.winnerId,
    )

    attempts = nextAttempts
    transitions = nextTransitions
    currentCandidateContent = revisionArtifact.refinedContent
    currentCandidateVersion = nextCandidateVersion
  }
}

export type CoverageExtraFixDomain = 'prd' | 'beads'

export interface CoverageExtraFixResult {
  domain: CoverageExtraFixDomain
  status: 'clean' | 'gaps'
  remainingGaps: string[]
  extraFixNumber: number | null
  changed: boolean
  summary: string
  noOp?: boolean
}

async function runPrdCoverageExtraFix(params: {
  ticketId: string
  context: TicketContext
  signal: AbortSignal
  worktreePath: string
  ticketDir: string
  ticketState: TicketState
  fixerId: string
  auditorId: string
  currentCandidateContent: string
  currentCandidateVersion: number
  remainingGaps: string[]
  history: LatestCoverageSnapshot
  councilSettings: ReturnType<typeof resolveCouncilRuntimeSettings>
  coverageSettings: ReturnType<typeof resolveCoverageRuntimeSettings>
  fullAnswersContent: string
}): Promise<CoverageExtraFixResult> {
  const stateLabel = 'WAITING_PRD_APPROVAL'
  const extraFixNumber = countExtraFixTransitions(params.history.transitions) + 1
  const previousExtraFixes = buildPreviousExtraFixHistory(params.history.transitions)

  params.ticketState.prd = params.currentCandidateContent
  clearContextCache(params.context.externalId)
  const revisionContext = buildMinimalContext('prd_coverage', params.ticketState)
  const revisionPromptContent = buildPromptFromTemplate(PROM13b, [
    ...revisionContext,
    {
      type: 'text',
      source: 'coverage_gaps',
      content: buildYamlDocument({ gaps: params.remainingGaps }),
    },
    {
      type: 'text',
      source: 'previous_extra_fixes',
      content: buildYamlDocument({ attempts: previousExtraFixes }),
    },
  ])

  const revisionRun = await runPrdCoverageResolutionPrompt({
    ticketId: params.ticketId,
    externalId: params.context.externalId,
    stateLabel,
    winnerId: params.fixerId,
    worktreePath: params.worktreePath,
    promptContent: revisionPromptContent,
    councilSettings: params.councilSettings,
    signal: params.signal,
    fullAnswersContent: params.fullAnswersContent,
    currentCandidateContent: params.currentCandidateContent,
    coverageGaps: params.remainingGaps,
    structuredRetryCount: resolveStructuredRetryRuntimeSettings(params.context).structuredRetryCount,
  })

  const changed = revisionRun.revision.refinedContent.trim() !== params.currentCandidateContent.trim()
  const nextCandidateVersion = changed ? params.currentCandidateVersion + 1 : params.currentCandidateVersion
  const revisionArtifact = buildPrdCoverageRevisionArtifact(
    params.fixerId,
    nextCandidateVersion,
    revisionRun.revision,
    revisionRun.structuredMeta,
  )
  const uiDiffArtifact = buildPrdCoverageRevisionUiDiff(revisionArtifact)

  if (changed) {
    insertPhaseArtifact(params.ticketId, {
      phase: stateLabel,
      artifactType: 'prd_coverage_revision',
      content: JSON.stringify({
        winnerId: revisionArtifact.winnerId,
        refinedContent: revisionArtifact.refinedContent,
        candidateVersion: revisionArtifact.candidateVersion,
        rawAttempts: revisionRun.rawAttempts,
        source: 'ai_fix_button',
        extraFixNumber,
      }),
    })
    persistUiArtifactCompanionArtifact(params.ticketId, stateLabel, 'prd_coverage_revision', {
      winnerId: revisionArtifact.winnerId,
      candidateVersion: revisionArtifact.candidateVersion,
      beforeContent: revisionArtifact.winnerDraftContent,
      afterContent: revisionArtifact.refinedContent,
      winnerDraftContent: revisionArtifact.winnerDraftContent,
      refinedContent: revisionArtifact.refinedContent,
      changes: revisionArtifact.changes,
      gapResolutions: revisionArtifact.gapResolutions,
      draftMetrics: revisionArtifact.draftMetrics,
      structuredOutput: revisionArtifact.structuredOutput ?? null,
      uiRefinementDiff: uiDiffArtifact,
      coverageBaselineContent: revisionArtifact.winnerDraftContent,
      coverageBaselineVersion: params.currentCandidateVersion,
      coverageUiRefinementDiff: uiDiffArtifact,
      rawAttempts: revisionRun.rawAttempts,
      source: 'ai_fix_button',
      extraFixNumber,
    })
    safeAtomicWrite(resolve(params.ticketDir, 'prd.yaml'), revisionArtifact.refinedContent)
  }

  params.ticketState.prd = revisionArtifact.refinedContent
  clearContextCache(params.context.externalId)
  const auditCoverageRunNumber = params.history.attempts.length + 1
  const auditMaxCoveragePasses = Math.max(
    params.history.maxCoveragePasses || params.coverageSettings.maxPrdCoveragePasses,
    auditCoverageRunNumber + 1,
  )
  const auditPromptContent = buildPromptFromTemplate(
    getCoveragePromptTemplate('prd'),
    [
      ...buildMinimalContext('prd_coverage', params.ticketState),
      buildCoveragePromptConfiguration({
        phase: 'prd',
        coverageRunNumber: auditCoverageRunNumber,
        maxCoveragePasses: auditMaxCoveragePasses,
        isFinalAllowedRun: false,
      }),
    ],
  )
  const auditResult = await runPrdCoverageAuditPrompt({
    ticketId: params.ticketId,
    externalId: params.context.externalId,
    stateLabel,
    winnerId: params.auditorId,
    worktreePath: params.worktreePath,
    promptContent: auditPromptContent,
    councilSettings: params.councilSettings,
    coverageRunNumber: auditCoverageRunNumber,
    maxCoveragePasses: auditMaxCoveragePasses,
    structuredRetryCount: resolveStructuredRetryRuntimeSettings(params.context).structuredRetryCount,
    signal: params.signal,
  })

  const hasRemainingGaps = auditResult.envelope.status === 'gaps'
  const latestExtraFixSummary = buildExtraFixTransitionSummary({
    phase: 'prd',
    extraFixNumber,
    fromVersion: params.currentCandidateVersion,
    toVersion: nextCandidateVersion,
    changed,
    remainingGaps: auditResult.envelope.gaps,
  })
  const attemptEntry: CoverageAttemptHistoryEntry = {
    candidateVersion: nextCandidateVersion,
    status: auditResult.envelope.status,
    summary: latestExtraFixSummary,
    gaps: [...auditResult.envelope.gaps],
    auditNotes: auditResult.normalizedContent,
    response: auditResult.response,
    normalizedContent: auditResult.normalizedContent,
    structuredOutput: auditResult.structuredMeta,
    rawAttempts: auditResult.rawAttempts,
    coverageRunNumber: auditCoverageRunNumber,
    maxCoveragePasses: auditMaxCoveragePasses,
    limitReached: false,
    terminationReason: hasRemainingGaps ? 'gaps' : 'clean',
    source: 'ai_fix_button',
    extraFixNumber,
  }
  const transitionEntry: CoverageTransitionHistoryEntry = {
    fromVersion: params.currentCandidateVersion,
    toVersion: nextCandidateVersion,
    summary: latestExtraFixSummary,
    gaps: [...params.remainingGaps],
    auditNotes: params.history.normalizedContent,
    fromContent: params.currentCandidateContent,
    toContent: revisionArtifact.refinedContent,
    gapResolutions: revisionArtifact.gapResolutions,
    resolutionNotes: revisionArtifact.gapResolutions.map((resolution) => resolution.rationale),
    uiRefinementDiff: uiDiffArtifact,
    structuredOutput: revisionRun.structuredMeta,
    rawAttempts: revisionRun.rawAttempts,
    source: 'ai_fix_button',
    extraFixNumber,
    noChange: !changed,
    label: changed
      ? `Extra Fix ${extraFixNumber}: v${params.currentCandidateVersion} > v${nextCandidateVersion}`
      : `Extra Fix ${extraFixNumber}: no change`,
  }

  persistVersionedCoverageArtifact({
    ticketId: params.ticketId,
    stateLabel,
    phase: 'prd',
    winnerId: params.auditorId,
    response: auditResult.response,
    normalizedContent: auditResult.normalizedContent,
    parsed: auditResult.envelope,
    structuredOutput: auditResult.structuredMeta,
    attemptEntry,
    attempts: [...params.history.attempts, attemptEntry],
    transitions: [...params.history.transitions, transitionEntry],
    coverageRunNumber: auditCoverageRunNumber,
    maxCoveragePasses: auditMaxCoveragePasses,
    limitReached: false,
    terminationReason: attemptEntry.terminationReason,
    finalCandidateVersion: nextCandidateVersion,
    hasRemainingGaps,
    remainingGaps: auditResult.envelope.gaps,
    latestExtraFixSummary,
  })

  emitModelSystemLog(
    params.ticketId,
    params.context.externalId,
    stateLabel,
    'info',
    latestExtraFixSummary,
    params.fixerId,
    { source: 'ai_fix_button', extraFixNumber },
  )

  return {
    domain: 'prd',
    status: auditResult.envelope.status,
    remainingGaps: auditResult.envelope.gaps,
    extraFixNumber,
    changed,
    summary: latestExtraFixSummary,
  }
}

async function runBeadsCoverageExtraFix(params: {
  ticketId: string
  context: TicketContext
  signal: AbortSignal
  worktreePath: string
  ticketState: TicketState
  fixerId: string
  auditorId: string
  currentCandidateContent: string
  currentCandidateVersion: number
  effectivePrdContent: string
  remainingGaps: string[]
  history: LatestCoverageSnapshot
  councilSettings: ReturnType<typeof resolveCouncilRuntimeSettings>
  coverageSettings: ReturnType<typeof resolveCoverageRuntimeSettings>
}) {
  const stateLabel = 'WAITING_BEADS_APPROVAL'
  const extraFixNumber = countExtraFixTransitions(params.history.transitions) + 1
  const previousExtraFixes = buildPreviousExtraFixHistory(params.history.transitions)

  params.ticketState.prd = params.effectivePrdContent
  params.ticketState.beads = params.currentCandidateContent
  clearContextCache(params.context.externalId)
  const revisionPromptContent = buildPromptFromTemplate(PROM24, [
    ...buildMinimalContext('beads_coverage', params.ticketState),
    {
      type: 'text',
      source: 'coverage_gaps',
      content: buildYamlDocument({ gaps: params.remainingGaps }),
    },
    {
      type: 'text',
      source: 'previous_extra_fixes',
      content: buildYamlDocument({ attempts: previousExtraFixes }),
    },
  ])

  const revisionRun = await runBeadsCoverageResolutionPrompt({
    ticketId: params.ticketId,
    externalId: params.context.externalId,
    stateLabel,
    winnerId: params.fixerId,
    worktreePath: params.worktreePath,
    promptContent: revisionPromptContent,
    councilSettings: params.councilSettings,
    signal: params.signal,
    currentCandidateContent: params.currentCandidateContent,
    coverageGaps: params.remainingGaps,
    structuredRetryCount: resolveStructuredRetryRuntimeSettings(params.context).structuredRetryCount,
  })

  const changed = revisionRun.revision.refinedContent.trim() !== params.currentCandidateContent.trim()
  const nextCandidateVersion = changed ? params.currentCandidateVersion + 1 : params.currentCandidateVersion
  const revisionArtifact = buildBeadsCoverageRevisionArtifact(
    params.fixerId,
    nextCandidateVersion,
    revisionRun.revision,
    revisionRun.structuredMeta,
    params.effectivePrdContent,
  )

  if (changed) {
    insertPhaseArtifact(params.ticketId, {
      phase: stateLabel,
      artifactType: 'beads_coverage_revision',
      content: JSON.stringify({
        winnerId: revisionArtifact.winnerId,
        refinedContent: revisionArtifact.refinedContent,
        candidateVersion: revisionArtifact.candidateVersion,
        rawAttempts: revisionRun.rawAttempts,
        source: 'ai_fix_button',
        extraFixNumber,
      }),
    })
    persistUiArtifactCompanionArtifact(params.ticketId, stateLabel, 'beads_coverage_revision', {
      winnerId: revisionArtifact.winnerId,
      candidateVersion: revisionArtifact.candidateVersion,
      beforeContent: revisionArtifact.winnerDraftContent,
      afterContent: revisionArtifact.refinedContent,
      winnerDraftContent: revisionArtifact.winnerDraftContent,
      refinedContent: revisionArtifact.refinedContent,
      changes: revisionArtifact.changes,
      gapResolutions: revisionArtifact.gapResolutions,
      draftMetrics: revisionArtifact.draftMetrics,
      structuredOutput: revisionArtifact.structuredOutput ?? null,
      uiRefinementDiff: revisionArtifact.uiRefinementDiff,
      coverageBaselineContent: revisionArtifact.winnerDraftContent,
      coverageBaselineVersion: params.currentCandidateVersion,
      coverageUiRefinementDiff: revisionArtifact.uiRefinementDiff,
      rawAttempts: revisionRun.rawAttempts,
      source: 'ai_fix_button',
      extraFixNumber,
    })
  }

  params.ticketState.prd = params.effectivePrdContent
  params.ticketState.beads = revisionArtifact.refinedContent
  clearContextCache(params.context.externalId)
  const auditCoverageRunNumber = params.history.attempts.length + 1
  const auditMaxCoveragePasses = Math.max(
    params.history.maxCoveragePasses || params.coverageSettings.maxBeadsCoveragePasses,
    auditCoverageRunNumber + 1,
  )
  const auditPromptContent = buildPromptFromTemplate(
    getCoveragePromptTemplate('beads'),
    [
      ...buildMinimalContext('beads_coverage', params.ticketState),
      buildCoveragePromptConfiguration({
        phase: 'beads',
        coverageRunNumber: auditCoverageRunNumber,
        maxCoveragePasses: auditMaxCoveragePasses,
        isFinalAllowedRun: false,
      }),
    ],
  )
  const auditResult = await runBeadsCoverageAuditPrompt({
    ticketId: params.ticketId,
    externalId: params.context.externalId,
    stateLabel,
    winnerId: params.auditorId,
    worktreePath: params.worktreePath,
    promptContent: auditPromptContent,
    councilSettings: params.councilSettings,
    structuredRetryCount: resolveStructuredRetryRuntimeSettings(params.context).structuredRetryCount,
    signal: params.signal,
  })

  if (changed) {
    await finalizeBeadsCoverageExpansion({
      ticketId: params.ticketId,
      externalId: params.context.externalId,
      stateLabel,
      winnerId: params.fixerId,
      worktreePath: params.worktreePath,
      signal: params.signal,
      councilSettings: params.councilSettings,
      ticketState: {
        ...params.ticketState,
        beads: revisionArtifact.refinedContent,
      },
      candidateContent: revisionArtifact.refinedContent,
      candidateVersion: nextCandidateVersion,
      structuredRetryCount: resolveStructuredRetryRuntimeSettings(params.context).structuredRetryCount,
    })
  }

  const hasRemainingGaps = auditResult.envelope.status === 'gaps'
  const latestExtraFixSummary = buildExtraFixTransitionSummary({
    phase: 'beads',
    extraFixNumber,
    fromVersion: params.currentCandidateVersion,
    toVersion: nextCandidateVersion,
    changed,
    remainingGaps: auditResult.envelope.gaps,
  })
  const attemptEntry: CoverageAttemptHistoryEntry = {
    candidateVersion: nextCandidateVersion,
    status: auditResult.envelope.status,
    summary: latestExtraFixSummary,
    gaps: [...auditResult.envelope.gaps],
    auditNotes: auditResult.normalizedContent,
    response: auditResult.response,
    normalizedContent: auditResult.normalizedContent,
    structuredOutput: auditResult.structuredMeta,
    rawAttempts: auditResult.rawAttempts,
    coverageRunNumber: auditCoverageRunNumber,
    maxCoveragePasses: auditMaxCoveragePasses,
    limitReached: false,
    terminationReason: hasRemainingGaps ? 'gaps' : 'clean',
    source: 'ai_fix_button',
    extraFixNumber,
  }
  const transitionEntry: CoverageTransitionHistoryEntry = {
    fromVersion: params.currentCandidateVersion,
    toVersion: nextCandidateVersion,
    summary: latestExtraFixSummary,
    gaps: [...params.remainingGaps],
    auditNotes: params.history.normalizedContent,
    fromContent: params.currentCandidateContent,
    toContent: revisionArtifact.refinedContent,
    gapResolutions: revisionArtifact.gapResolutions,
    resolutionNotes: revisionArtifact.gapResolutions.map((resolution) => resolution.rationale),
    uiRefinementDiff: revisionArtifact.uiRefinementDiff,
    structuredOutput: revisionRun.structuredMeta,
    rawAttempts: revisionRun.rawAttempts,
    source: 'ai_fix_button',
    extraFixNumber,
    noChange: !changed,
    label: changed
      ? `Extra Fix ${extraFixNumber}: v${params.currentCandidateVersion} > v${nextCandidateVersion}`
      : `Extra Fix ${extraFixNumber}: no change`,
  }

  persistVersionedCoverageArtifact({
    ticketId: params.ticketId,
    stateLabel,
    phase: 'beads',
    winnerId: params.auditorId,
    response: auditResult.response,
    normalizedContent: auditResult.normalizedContent,
    parsed: auditResult.envelope,
    structuredOutput: auditResult.structuredMeta,
    attemptEntry,
    attempts: [...params.history.attempts, attemptEntry],
    transitions: [...params.history.transitions, transitionEntry],
    coverageRunNumber: auditCoverageRunNumber,
    maxCoveragePasses: auditMaxCoveragePasses,
    limitReached: false,
    terminationReason: attemptEntry.terminationReason,
    finalCandidateVersion: nextCandidateVersion,
    hasRemainingGaps,
    remainingGaps: auditResult.envelope.gaps,
    latestExtraFixSummary,
  })

  emitModelSystemLog(
    params.ticketId,
    params.context.externalId,
    stateLabel,
    'info',
    latestExtraFixSummary,
    params.fixerId,
    { source: 'ai_fix_button', extraFixNumber },
  )

  return {
    domain: 'beads',
    status: auditResult.envelope.status,
    remainingGaps: auditResult.envelope.gaps,
    extraFixNumber,
    changed,
    summary: latestExtraFixSummary,
  } satisfies CoverageExtraFixResult
}

export async function performCoverageExtraFix(params: {
  ticketId: string
  context: TicketContext
  domain: CoverageExtraFixDomain
  signal: AbortSignal
}): Promise<CoverageExtraFixResult> {
  const history = loadLatestCoverageSnapshot(params.ticketId, params.domain)
  if (!history || history.status === 'clean' || history.remainingGaps.length === 0) {
    return {
      domain: params.domain,
      status: 'clean',
      remainingGaps: [],
      extraFixNumber: null,
      changed: false,
      summary: 'No open coverage gaps remain.',
      noOp: true,
    }
  }

  const { worktreePath, ticket, ticketDir, relevantFiles } = loadTicketDirContext(params.context)
  const councilSettings = resolveCouncilRuntimeSettings(params.context)
  const coverageSettings = resolveCoverageRuntimeSettings(params.context)
  const auditorId = getPlanningWinnerId(params.ticketId, params.domain)
  const fixerId = params.context.lockedMainImplementer?.trim() || auditorId
  const ticketState: TicketState = {
    ticketId: params.context.externalId,
    title: params.context.title,
    description: ticket?.description ?? '',
    relevantFiles,
  }

  if (params.domain === 'prd') {
    const fullAnswersContent = loadWinnerPrdFullAnswers(params.ticketId, auditorId)
    if (!fullAnswersContent) {
      throw new Error(`PRD extra fix requires the winning model's Full Answers artifact for ${auditorId}, but it was not available.`)
    }
    const prdPath = resolve(ticketDir, 'prd.yaml')
    const currentCandidateContent = existsSync(prdPath) ? readFileSync(prdPath, 'utf-8').trim() : ''
    if (!currentCandidateContent) {
      throw new Error('PRD extra fix requires a current prd.yaml artifact.')
    }

    return runPrdCoverageExtraFix({
      ticketId: params.ticketId,
      context: params.context,
      signal: params.signal,
      worktreePath,
      ticketDir,
      ticketState: {
        ...ticketState,
        fullAnswers: [fullAnswersContent],
        prd: currentCandidateContent,
      },
      fixerId,
      auditorId,
      currentCandidateContent,
      currentCandidateVersion: history.finalCandidateVersion ?? 1,
      remainingGaps: history.remainingGaps,
      history,
      councilSettings,
      coverageSettings,
      fullAnswersContent,
    })
  }

  const prdPath = resolve(ticketDir, 'prd.yaml')
  const effectivePrdContent = existsSync(prdPath) ? readFileSync(prdPath, 'utf-8').trim() : ''
  if (!effectivePrdContent) {
    throw new Error('Beads extra fix requires an approved PRD artifact.')
  }
  const semanticInput = getLatestBeadsSemanticCoverageInput(params.ticketId)
  if (!semanticInput) {
    throw new Error('Beads extra fix requires a semantic beads blueprint from coverage or refinement history.')
  }

  return runBeadsCoverageExtraFix({
    ticketId: params.ticketId,
    context: params.context,
    signal: params.signal,
    worktreePath,
    ticketState: {
      ...ticketState,
      prd: effectivePrdContent,
      beads: semanticInput.candidateContent,
    },
    fixerId,
    auditorId,
    currentCandidateContent: semanticInput.candidateContent,
    currentCandidateVersion: history.finalCandidateVersion ?? semanticInput.candidateVersion,
    effectivePrdContent,
    remainingGaps: history.remainingGaps,
    history,
    councilSettings,
    coverageSettings,
  })
}

export async function handleRelevantFilesScan(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
  signal: AbortSignal,
) {
  const phase = 'SCANNING_RELEVANT_FILES' as const
  const { worktreePath, ticket, ticketDir } = loadTicketDirContext(context)

  const ticketState: TicketState = {
    ticketId: context.externalId,
    title: context.title,
    description: ticket?.description ?? '',
  }

  const contextParts = buildMinimalContext('preflight', ticketState)
  const prompt = buildPromptFromTemplate(PROM0, contextParts)

  const codingModelId = context.lockedMainImplementer
  if (!codingModelId) {
    const msg = 'No main implementer configured for relevant files scan.'
    emitPhaseLog(ticketId, context.externalId, phase, 'error', msg)
    sendEvent({ type: 'ERROR', message: msg, codes: ['RELEVANT_FILES_SCAN_FAILED', 'MAIN_IMPLEMENTER_MISSING'] })
    return
  }

  let sessionId = ''
  try {
    const { draftTimeoutMs } = resolveCouncilRuntimeSettings(context)
    const streamState = createOpenCodeStreamState()
    const openCodeDiagnostics: Array<ReturnType<typeof buildOpenCodeBlockedErrorDiagnostics>> = []
    const rememberOpenCodeDiagnostics = (runResult: OpenCodeRunResult) => {
      const diagnosticResult = buildOpenCodeBlockedErrorDiagnostics({
        responseMeta: runResult.responseMeta,
        attemptMeta: runResult.attemptMeta,
        modelId: codingModelId,
        sessionId: runResult.session.id,
      })
      if (diagnosticResult.diagnostics) {
        openCodeDiagnostics.push(diagnosticResult)
      }
    }
    const initialPromptParts = [{ type: 'text' as const, content: prompt }]
    const initialInput = formatPromptText(initialPromptParts)

    const result = await runOpenCodePrompt({
      adapter,
      projectPath: worktreePath,
      parts: initialPromptParts,
      signal,
      timeoutMs: draftTimeoutMs,
      timeoutKind: 'ai_response',
      model: codingModelId,
      variant: 'relevant_files_scan',
      erroredSessionPolicy: 'discard_errored_session_output',
      toolPolicy: PROM0.toolPolicy,
      onSessionCreated: (session) => {
        sessionId = session.id
        emitAiMilestone(
          ticketId,
          context.externalId,
          phase,
          `Scanning relevant files with ${codingModelId} (session=${session.id}).`,
          `${phase}:${session.id}:scan-created`,
          {
            modelId: codingModelId,
            sessionId: session.id,
            source: `model:${codingModelId}`,
          },
        )
      },
      onStreamEvent: (event) => {
        if (!sessionId) return
        emitOpenCodeStreamEvent(
          ticketId,
          context.externalId,
          phase,
          codingModelId,
          sessionId,
          event,
          streamState,
        )
      },
      onPromptDispatched: (event) => {
        emitOpenCodePromptLog(
          ticketId,
          context.externalId,
          phase,
          codingModelId,
          event,
        )
      },
    })
    rememberOpenCodeDiagnostics(result)

    throwIfAborted(signal, ticketId)

    emitOpenCodeSessionLogs(
      ticketId,
      context.externalId,
      phase,
      codingModelId,
      result.session.id,
      'relevant_files_scan',
      result.response,
      result.messages,
      streamState,
    )

    let normalized = validateRelevantFilesScanResponse(result.response)
    let finalResponse = result.response
    let finalResponseMeta = result.responseMeta
    const rawAttempts: RawAttempt[] = []
    let retryMeta = buildStructuredMetadata({
      autoRetryCount: 0,
      repairApplied: false,
      repairWarnings: [],
    })

    const structuredRetryCount = resolveStructuredRetryRuntimeSettings(context).structuredRetryCount
    while (!normalized.ok && retryMeta.autoRetryCount < structuredRetryCount) {
      const retryDecision = getStructuredRetryDecision(finalResponse, finalResponseMeta)
      const rawAttempt = appendRejectedRawAttempt(rawAttempts, {
        stage: 'relevant_files_scan',
        rawResponse: finalResponse,
        initialInput,
        validationError: normalized.error,
        failureClass: retryDecision.failureClass,
      })
      const retryMode = retryDecision.reuseSession ? 'continued session' : 'fresh session'
      const nextRetryCount = (retryMeta.autoRetryCount ?? 0) + 1
      retryMeta = buildStructuredMetadata(retryMeta, {
        autoRetryCount: nextRetryCount,
        validationError: normalized.error,
        retryDiagnostics: [
          ...(retryMeta.retryDiagnostics ?? []),
          resolveStructuredRetryDiagnostic({
            attempt: rawAttempt.attempt,
            rawResponse: finalResponse,
            validationError: normalized.error,
            failureClass: retryDecision.failureClass,
            retryDiagnostic: normalized.retryDiagnostic,
          }),
        ],
      })
      emitPhaseLog(
        ticketId,
        context.externalId,
        phase,
        'info',
        `Relevant files scan response failed validation; retrying structured output (${nextRetryCount}/${structuredRetryCount}) in a ${retryMode}: ${normalized.error}`,
      )

      if (retryDecision.reuseSession) {
        const retryParts = buildStructuredRetryPrompt([{ type: 'text', content: prompt }], {
          validationError: normalized.error,
          rawResponse: finalResponse,
          schemaReminder: PROM0.outputFormat,
        })

        const retryResult = await runOpenCodeSessionPrompt({
          adapter,
          session: { id: sessionId || result.session.id },
          parts: retryParts,
          signal,
          timeoutMs: draftTimeoutMs,
          timeoutKind: 'ai_response',
          model: codingModelId,
          erroredSessionPolicy: 'discard_errored_session_output',
          toolPolicy: PROM0.toolPolicy,
          onStreamEvent: (event) => {
            if (!sessionId) return
            emitOpenCodeStreamEvent(
              ticketId,
              context.externalId,
              phase,
              codingModelId,
              sessionId,
              event,
              streamState,
            )
          },
          onPromptDispatched: (event) => {
            emitOpenCodePromptLog(
              ticketId,
              context.externalId,
              phase,
              codingModelId,
              event,
            )
          },
        })
        rememberOpenCodeDiagnostics(retryResult)

        throwIfAborted(signal, ticketId)

        emitOpenCodeSessionLogs(
          ticketId,
          context.externalId,
          phase,
          codingModelId,
          retryResult.session.id,
          'relevant_files_scan',
          retryResult.response,
          retryResult.messages,
          streamState,
        )

        finalResponse = retryResult.response
        finalResponseMeta = retryResult.responseMeta
      } else {
        const freshResult = await runOpenCodePrompt({
          adapter,
          projectPath: worktreePath,
          parts: initialPromptParts,
          signal,
          timeoutMs: draftTimeoutMs,
          timeoutKind: 'ai_response',
          model: codingModelId,
          variant: 'relevant_files_scan',
          erroredSessionPolicy: 'discard_errored_session_output',
          toolPolicy: PROM0.toolPolicy,
          onSessionCreated: (session) => {
            sessionId = session.id
            emitAiMilestone(
              ticketId,
              context.externalId,
              phase,
              `Restarting relevant files scan with ${codingModelId} in a fresh session (session=${session.id}).`,
              `${phase}:${session.id}:scan-restarted`,
              {
                modelId: codingModelId,
                sessionId: session.id,
                source: `model:${codingModelId}`,
              },
            )
          },
          onStreamEvent: (event) => {
            if (!sessionId) return
            emitOpenCodeStreamEvent(
              ticketId,
              context.externalId,
              phase,
              codingModelId,
              sessionId,
              event,
              streamState,
            )
          },
          onPromptDispatched: (event) => {
            emitOpenCodePromptLog(
              ticketId,
              context.externalId,
              phase,
              codingModelId,
              event,
            )
          },
        })
        rememberOpenCodeDiagnostics(freshResult)

        throwIfAborted(signal, ticketId)

        emitOpenCodeSessionLogs(
          ticketId,
          context.externalId,
          phase,
          codingModelId,
          freshResult.session.id,
          'relevant_files_scan',
          freshResult.response,
          freshResult.messages,
          streamState,
        )

        finalResponse = freshResult.response
        finalResponseMeta = freshResult.responseMeta
      }

      normalized = validateRelevantFilesScanResponse(finalResponse)
    }

    if (!normalized.ok) {
      const retryDecision = getStructuredRetryDecision(finalResponse, finalResponseMeta)
      const rawAttempt = appendRejectedRawAttempt(rawAttempts, {
        stage: 'relevant_files_scan',
        rawResponse: finalResponse,
        initialInput,
        validationError: normalized.error,
        failureClass: retryDecision.failureClass,
      })
      const failedStructuredMeta = buildStructuredMetadata(retryMeta, {
        autoRetryCount: retryMeta.autoRetryCount,
        validationError: normalized.error,
        retryDiagnostics: [
          ...(retryMeta.retryDiagnostics ?? []),
          resolveStructuredRetryDiagnostic({
            attempt: rawAttempt.attempt,
            rawResponse: finalResponse,
            validationError: normalized.error,
            failureClass: retryDecision.failureClass,
            retryDiagnostic: normalized.retryDiagnostic,
          }),
        ],
      })
      const latestOpenCodeDiagnostics = openCodeDiagnostics.at(-1) ?? null
      const baseMsg = `Relevant files scan failed validation after ${structuredRetryCount} structured retry attempt(s): ${normalized.error}`
      const msg = appendBlockedErrorDiagnosticsSummary(baseMsg, latestOpenCodeDiagnostics?.diagnostics)
      emitPhaseLog(ticketId, context.externalId, phase, 'error', msg)
      insertPhaseArtifact(ticketId, {
        phase,
        artifactType: 'relevant_files_scan',
        content: JSON.stringify({
          fileCount: 0,
          files: [],
          modelId: codingModelId,
          structuredOutput: failedStructuredMeta,
          rawAttempts,
          errors: [normalized.error],
        }),
      })
      sendEvent({
        type: 'ERROR',
        message: msg,
        codes: mergeErrorCodes(['RELEVANT_FILES_SCAN_FAILED'], latestOpenCodeDiagnostics?.errorCodes ?? []),
        ...(latestOpenCodeDiagnostics?.diagnostics ? { diagnostics: latestOpenCodeDiagnostics.diagnostics } : {}),
      })
      return
    }

    if (rawAttempts.length === 0 || rawAttempts.at(-1)?.outcome === 'rejected') {
      appendAcceptedRawAttempt(rawAttempts, {
        stage: 'relevant_files_scan',
        rawResponse: finalResponse,
        initialInput,
      })
    }

    const structuredMeta = buildStructuredMetadata(retryMeta, {
      repairApplied: normalized.repairApplied,
      repairWarnings: normalized.repairWarnings,
    })

    const parsed: RelevantFilesData = {
      file_count: normalized.value.file_count,
      files: normalized.value.files.map((f) => ({
        path: f.path,
        rationale: f.rationale,
        relevance: (['high', 'medium', 'low'].includes(f.relevance) ? f.relevance : 'medium') as 'high' | 'medium' | 'low',
        likely_action: (['read', 'modify', 'create'].includes(f.likely_action) ? f.likely_action : 'read') as 'read' | 'modify' | 'create',
        content: f.content,
        content_preview: f.content_preview,
      })),
    }
    const artifactContent = buildRelevantFilesArtifact(context.externalId, parsed)
    const artifactPath = resolve(ticketDir, 'relevant-files.yaml')
    safeAtomicWrite(artifactPath, artifactContent)

    insertPhaseArtifact(ticketId, {
      phase,
      artifactType: 'relevant_files_scan',
      content: JSON.stringify({
        fileCount: parsed.file_count,
        files: parsed.files.map(f => ({
          path: f.path,
          rationale: f.rationale,
          relevance: f.relevance,
          likely_action: f.likely_action,
          contentPreview: f.content_preview ?? '',
          contentLength: (f.content_preview ?? f.content ?? '').length,
        })),
        modelId: codingModelId,
        structuredOutput: structuredMeta,
        rawAttempts,
      }),
    })

    emitPhaseLog(ticketId, context.externalId, phase, 'info', `Relevant files scan completed: ${parsed.file_count} files extracted.`)
    sendEvent({ type: 'RELEVANT_FILES_READY' })
  } catch (err) {
    if (err instanceof CancelledError) throw err
    if (err instanceof Error && err.message === 'Timeout') {
      const diagnosticResult = buildOpenCodeBlockedErrorDiagnostics({
        error: err,
        modelId: codingModelId,
        sessionId,
        fallbackMessage: 'Timeout',
      })
      const msg = appendBlockedErrorDiagnosticsSummary('Relevant files scan failed: Timeout', diagnosticResult.diagnostics)
      emitPhaseLog(ticketId, context.externalId, phase, 'error', msg)
      sendEvent({
        type: 'ERROR',
        message: msg,
        codes: mergeErrorCodes(['RELEVANT_FILES_SCAN_FAILED'], diagnosticResult.errorCodes),
        ...(diagnosticResult.diagnostics ? { diagnostics: diagnosticResult.diagnostics } : {}),
      })
      return
    }
    throwIfCancelled(err, signal, ticketId)
    const errMsg = getErrorMessage(err)
    const diagnosticResult = buildOpenCodeBlockedErrorDiagnostics({
      error: err,
      modelId: codingModelId,
      sessionId,
      fallbackMessage: errMsg,
    })
    const baseMsg = `Relevant files scan failed: ${errMsg}`
    const msg = appendBlockedErrorDiagnosticsSummary(baseMsg, diagnosticResult.diagnostics)
    emitPhaseLog(ticketId, context.externalId, phase, 'error', msg)
    sendEvent({
      type: 'ERROR',
      message: msg,
      codes: mergeErrorCodes(['RELEVANT_FILES_SCAN_FAILED'], diagnosticResult.errorCodes),
      ...(diagnosticResult.diagnostics ? { diagnostics: diagnosticResult.diagnostics } : {}),
    })
  }
}

export async function handleCoverageVerification(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
  phase: 'interview' | 'prd' | 'beads',
  signal: AbortSignal,
) {
  const { worktreePath, ticket, ticketDir, relevantFiles } = loadTicketDirContext(context)
  const paths = getTicketPaths(ticketId)
  const stateLabel = getCoverageStateLabel(phase)
  const contextPhase = getCoverageContextPhase(phase)
  const promptTemplate = getCoveragePromptTemplate(phase)
  const councilSettings = resolveCouncilRuntimeSettings(context)
  const coverageSettings = resolveCoverageRuntimeSettings(context)
  const configuredMaxCoveragePasses = phase === 'interview'
    ? coverageSettings.maxCoveragePasses
    : phase === 'prd'
      ? coverageSettings.maxPrdCoveragePasses
      : coverageSettings.maxBeadsCoveragePasses
  const effectiveMaxCoveragePasses = getVersionedCoveragePassLimit(phase, configuredMaxCoveragePasses)
  const completedCoveragePasses = countPhaseArtifacts(ticketId, `${phase}_coverage`, stateLabel)
  const coverageRunState = resolveCoverageRunState(completedCoveragePasses, effectiveMaxCoveragePasses)

  if (coverageRunState.limitAlreadyReached) {
    emitPhaseLog(
      ticketId,
      context.externalId,
      stateLabel,
      'info',
      `Coverage retry cap already reached for ${phase} (${completedCoveragePasses}/${effectiveMaxCoveragePasses}). Routing to approval without another coverage execution.`,
    )
    sendEvent({ type: 'COVERAGE_LIMIT_REACHED' })
    return
  }

  const { coverageRunNumber, isFinalAllowedRun } = coverageRunState

  const winnerArtifact = phase === 'interview'
    ? getLatestPhaseArtifact(ticketId, 'interview_winner')
    : phase === 'prd'
      ? getLatestPhaseArtifact(ticketId, 'prd_winner') ?? getLatestPhaseArtifact(ticketId, 'prd_votes')
      : getLatestPhaseArtifact(ticketId, 'beads_winner') ?? getLatestPhaseArtifact(ticketId, 'beads_votes')

  if (!winnerArtifact) {
    const msg = `No persisted council winner found for ${phase} phase — cannot determine winning model`
    emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
    sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
    return
  }

  let winnerId = ''
  try {
    const parsed = JSON.parse(winnerArtifact.content) as { winnerId?: string }
    winnerId = parsed.winnerId ?? ''
  } catch {
    const msg = `Failed to parse winning model from persisted artifact for ${phase} phase`
    emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
    sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
    return
  }

  if (!winnerId) {
    const msg = `No winnerId found in persisted artifact for ${phase} phase`
    emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
    sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
    return
  }
  emitModelSystemLog(
    ticketId,
    context.externalId,
    stateLabel,
    'info',
    `Coverage verification started using winning model: ${winnerId} (run ${coverageRunNumber}/${effectiveMaxCoveragePasses}).`,
    winnerId,
  )

  // Resolve refinedContent: prefer in-memory, fall back to persisted artifact
  let refinedContent: string | undefined
  if (!refinedContent) {
    if (phase === 'beads') {
      refinedContent = loadLatestBeadsCandidateContent(ticketId) ?? undefined
    }
    const compiledArtifact = phase === 'beads'
      ? null
      : getLatestPhaseArtifact(ticketId, phase === 'interview' ? 'interview_compiled' : 'prd_refined')
    if (compiledArtifact) {
      try {
        refinedContent = phase === 'prd'
          ? parsePrdRefinedArtifact(compiledArtifact.content).refinedContent
          : parseCompiledInterviewArtifact(compiledArtifact.content).refinedContent
      } catch {
        // Ignore malformed refinement artifacts and fall back to other sources.
      }
    }
  }

  const interviewSnapshot = phase === 'interview'
    ? readInterviewSessionSnapshotArtifact(ticketId)
    : null
  let canonicalInterview = phase === 'interview'
    ? loadCanonicalInterview(ticketDir)
    : undefined
  let effectivePrdContent: string | undefined
  let effectiveBeadsContent: string | undefined

  if (phase === 'interview' && !canonicalInterview) {
    if (!interviewSnapshot) {
      const msg = 'Interview coverage requires canonical interview state, but no normalized interview session snapshot was found.'
      emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
      sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
      return
    }

    try {
      writeCanonicalInterview(context.externalId, ticketDir, interviewSnapshot)
      canonicalInterview = loadCanonicalInterview(ticketDir)
    } catch (err) {
      const msg = `Failed to rebuild canonical interview.yaml before coverage: ${getErrorMessage(err)}`
      emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
      sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
      return
    }
  }

  if (phase === 'prd') {
    const prdPath = resolve(ticketDir, 'prd.yaml')
    const diskPrdContent = existsSync(prdPath) ? readFileSync(prdPath, 'utf-8').trim() : ''
    if (diskPrdContent.length > 0) {
      effectivePrdContent = diskPrdContent
    } else if (refinedContent?.trim()) {
      effectivePrdContent = refinedContent.trim()
      try {
        safeAtomicWrite(prdPath, refinedContent)
        emitPhaseLog(ticketId, context.externalId, stateLabel, 'info', `Recovered missing prd.yaml from the validated refined PRD artifact before coverage.`)
      } catch (err) {
        const msg = `Failed to restore prd.yaml from the validated refined PRD artifact before coverage: ${getErrorMessage(err)}`
        emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
        sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
        return
      }
    } else {
      const recoveredPrdContent = loadRecoveredPrdCoverageContent(ticketId)
      if (!recoveredPrdContent) {
        const msg = 'PRD coverage requires a canonical prd.yaml or recovered prd_refined artifact, but neither was available.'
        emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
        sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
        return
      }

      effectivePrdContent = recoveredPrdContent.trim()
      try {
        safeAtomicWrite(prdPath, recoveredPrdContent)
        emitPhaseLog(ticketId, context.externalId, stateLabel, 'info', `Recovered missing prd.yaml from the validated refined PRD artifact before coverage.`)
      } catch (err) {
        const msg = `Failed to restore prd.yaml from the validated refined PRD artifact before coverage: ${getErrorMessage(err)}`
        emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
        sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
        return
      }
    }
  }

  if (phase === 'beads') {
    const prdPath = resolve(ticketDir, 'prd.yaml')
    const diskPrdContent = existsSync(prdPath) ? readFileSync(prdPath, 'utf-8').trim() : ''
    if (!diskPrdContent) {
      const msg = 'Beads coverage requires an approved PRD, but prd.yaml was not available.'
      emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
      sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
      return
    }
    effectivePrdContent = diskPrdContent

    if (!paths) {
      const msg = 'Beads coverage requires a ticket workspace path, but it was not available.'
      emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
      sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
      return
    }

    if (refinedContent?.trim()) {
      effectiveBeadsContent = refinedContent.trim()
    } else {
      const recoveredBeadsContent = loadLatestBeadsCandidateContent(ticketId)
      if (!recoveredBeadsContent) {
        const msg = 'Beads coverage requires a canonical semantic beads blueprint or recovered beads coverage revision artifact, but neither was available.'
        emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
        sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
        return
      }

      effectiveBeadsContent = recoveredBeadsContent.trim()
      if (!effectiveBeadsContent) {
        const msg = 'Recovered beads coverage content was empty.'
        emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
        sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
        return
      }
      emitPhaseLog(ticketId, context.externalId, stateLabel, 'info', 'Recovered semantic beads blueprint from the latest persisted refinement artifact before coverage.')
    }

    const normalizedBlueprint = normalizeBeadSubsetYamlOutput(effectiveBeadsContent)
    if (!normalizedBlueprint.ok) {
      const msg = `Beads coverage requires a valid semantic blueprint, but the recovered artifact failed validation: ${normalizedBlueprint.error}`
      emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
      sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
      return
    }
  }

  const winnerFullAnswers = phase === 'prd' ? loadWinnerPrdFullAnswers(ticketId, winnerId) : undefined
  if (phase === 'prd' && !winnerFullAnswers) {
    const msg = `PRD coverage requires the winning model's Full Answers artifact for ${winnerId}, but it was not available.`
    emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
    sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
    return
  }

  const ticketState: TicketState = {
    ticketId: context.externalId,
    title: context.title,
    description: ticket?.description ?? '',
    relevantFiles,
    ...(phase === 'interview'
      ? { interview: canonicalInterview }
      : {}),
    ...(phase === 'prd'
      ? { fullAnswers: [winnerFullAnswers!] }
      : {}),
    ...(phase === 'prd' && effectivePrdContent
      ? { prd: effectivePrdContent }
      : {}),
    ...(phase === 'beads' && effectivePrdContent
      ? { prd: effectivePrdContent }
      : {}),
    ...(phase === 'beads' && effectiveBeadsContent
      ? { beads: effectiveBeadsContent }
      : {}),
    ...(phase === 'interview'
      ? { userAnswers: buildInterviewAnswerSummary(interviewSnapshot) }
      : {}),
  }

  const interviewCoverageBudget = phase === 'interview'
    ? (() => {
        const maxInitialQuestions = context.lockedInterviewQuestions
          ?? interviewSnapshot?.maxInitialQuestions
          ?? resolveInterviewDraftSettings(context).maxInitialQuestions
        const total = calculateFollowUpLimit(maxInitialQuestions, coverageSettings.coverageFollowUpBudgetPercent)
        const used = interviewSnapshot ? countCoverageFollowUpQuestions(interviewSnapshot) : 0
        return {
          total,
          used,
          remaining: Math.max(0, total - used),
        }
      })()
    : null

  if (phase === 'prd') {
    await handlePrdCoverageVerificationLoop({
      ticketId,
      context,
      sendEvent,
      signal,
      worktreePath,
      ticketDir,
      winnerId,
      stateLabel,
      ticketState,
      effectivePrdContent: effectivePrdContent ?? '',
      fullAnswersContent: winnerFullAnswers!,
      councilSettings,
      coverageSettings,
    })
    return
  }

  if (phase === 'beads') {
    await handleBeadsCoverageVerificationLoop({
      ticketId,
      context,
      sendEvent,
      signal,
      worktreePath,
      winnerId,
      stateLabel,
      ticketState,
      effectivePrdContent: effectivePrdContent ?? '',
      effectiveBeadsContent: effectiveBeadsContent ?? '',
      councilSettings,
      coverageSettings,
    })
    return
  }

  clearContextCache(context.externalId)
  const coverageContext = buildMinimalContext(contextPhase, ticketState)
  const coveragePromptConfiguration = buildCoveragePromptConfiguration({
    phase,
    coverageRunNumber,
    maxCoveragePasses: effectiveMaxCoveragePasses,
    isFinalAllowedRun,
    ...(phase === 'interview' && interviewCoverageBudget
      ? {
          coverageFollowUpBudgetPercent: coverageSettings.coverageFollowUpBudgetPercent,
          followUpBudgetTotal: interviewCoverageBudget.total,
          followUpBudgetUsed: interviewCoverageBudget.used,
          followUpBudgetRemaining: interviewCoverageBudget.remaining,
        }
      : {}),
  })
  const promptContent = buildPromptFromTemplate(
    promptTemplate,
    [...coverageContext, coveragePromptConfiguration],
  )

  // Use a single session for the winning model only (not all council members)
  throwIfAborted(signal, ticketId)
  const streamState = createOpenCodeStreamState()
  let sessionId = ''
  let runResult: Awaited<ReturnType<typeof runOpenCodePrompt>> | undefined
  let response = ''
  let coverageEnvelope: ReturnType<typeof normalizeCoverageResultOutput> | null = null
  let promptParts: PromptPart[] = [{ type: 'text', content: promptContent }]
  let structuredMeta = buildStructuredMetadata({ autoRetryCount: 0, repairApplied: false, repairWarnings: [] })
  let interviewCoverageResolution: ReturnType<typeof resolveInterviewCoverageFollowUpResolution> | null = null
  const structuredRetryCount = resolveStructuredRetryRuntimeSettings(context).structuredRetryCount
  let latestOpenCodeDiagnostics: OpenCodeDiagnosticResult | null = null

  for (let attempt = 0; attempt <= structuredRetryCount; attempt += 1) {
    const diagnosticTracker = createOpenCodeDiagnosticTracker(winnerId)
    try {
      runResult = await runOpenCodePrompt({
        adapter,
        projectPath: worktreePath,
        parts: promptParts,
        signal,
        timeoutMs: councilSettings.draftTimeoutMs,
        model: winnerId,
        erroredSessionPolicy: 'discard_errored_session_output',
        toolPolicy: promptTemplate.toolPolicy,
        sessionOwnership: {
          ticketId,
          phase: stateLabel,
          memberId: winnerId,
        },
        onSessionCreated: (session) => {
          sessionId = session.id
          emitAiMilestone(
            ticketId,
            context.externalId,
            stateLabel,
            `OpenCode coverage: sending ${phase} verification prompt to ${winnerId} (session=${session.id}).`,
            `${stateLabel}:${session.id}:coverage-created`,
            {
              modelId: winnerId,
              sessionId: session.id,
              source: `model:${winnerId}`,
            },
          )
        },
        onStreamEvent: (event) => {
          diagnosticTracker.observeStreamEvent(event)
          if (!sessionId) return
          emitOpenCodeStreamEvent(
            ticketId,
            context.externalId,
            stateLabel,
            winnerId,
            sessionId,
            event,
            streamState,
          )
        },
        onPromptDispatched: (event) => {
          emitOpenCodePromptLog(
            ticketId,
            context.externalId,
            stateLabel,
            winnerId,
            event,
          )
        },
      })
    } catch (error) {
      if (error instanceof CancelledError) throw error
      if (error instanceof Error && error.message === 'Timeout') {
        emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', `Coverage verification failed: Timeout`)
        sendEvent({ type: 'ERROR', message: `Coverage verification failed: Timeout`, codes: ['COVERAGE_FAILED'] })
        return
      }
      throwIfCancelled(error, signal, ticketId)
      throw error
    }

    throwIfAborted(signal, ticketId)
    response = runResult.response
    const runDiagnostics = diagnosticTracker.build(runResult)
    if (runDiagnostics.diagnostics) {
      latestOpenCodeDiagnostics = runDiagnostics
    }

    emitOpenCodeSessionLogs(
      ticketId,
      context.externalId,
      stateLabel,
      winnerId,
      runResult.session.id,
      'coverage',
      response,
      runResult.messages,
      streamState,
    )

    coverageEnvelope = normalizeCoverageResultOutput(response)
    if (coverageEnvelope.ok) {
      structuredMeta = buildStructuredMetadata(structuredMeta, {
        repairApplied: coverageEnvelope.repairApplied,
        repairWarnings: coverageEnvelope.repairWarnings,
      })

      // PRD coverage is handled by handlePrdCoverageVerificationLoop (returns early above)

      // An explicit clean/pass status used to win regardless of the gaps or
      // follow-up questions beside it, and the follow-up resolution below then
      // dropped every one of them because the status was not `gaps`.
      const interviewCoverageNormalization = phase === 'interview'
        ? normalizeInterviewCoverageEnvelope(coverageEnvelope.value)
        : null
      if (interviewCoverageNormalization) {
        coverageEnvelope = {
          ...coverageEnvelope,
          value: interviewCoverageNormalization.envelope,
          normalizedContent: buildCoverageEnvelopeYaml(interviewCoverageNormalization.envelope),
        }
        if (interviewCoverageNormalization.repairWarnings.length > 0) {
          structuredMeta = buildStructuredMetadata(structuredMeta, {
            repairWarnings: interviewCoverageNormalization.repairWarnings,
          })
        }
      }

      const coverageConsistencyError = interviewCoverageNormalization?.validationError
      if (coverageConsistencyError && attempt < structuredRetryCount) {
        structuredMeta = buildStructuredMetadata(structuredMeta, {
          autoRetryCount: attempt + 1,
          validationError: coverageConsistencyError,
          retryDiagnostics: [resolveStructuredRetryDiagnostic({
            attempt: (structuredMeta.autoRetryCount ?? 0) + 1,
            rawResponse: response,
            validationError: coverageConsistencyError,
          })],
        })
        promptParts = buildStructuredRetryPrompt([{ type: 'text', content: promptContent }], {
          validationError: coverageConsistencyError,
          rawResponse: response,
          schemaReminder: promptTemplate.outputFormat,
        })
        continue
      }

      // Retries are spent and the envelope still contradicts itself. Recording the
      // error and carrying on left `status: clean` standing, so the gaps the model
      // did report were dropped and the run emitted COVERAGE_CLEAN.
      let coverageConsistencyReconciled = false
      if (coverageConsistencyError) {
        const reconciled = reconcileExhaustedCoverageEnvelope(coverageEnvelope.value)
        if (reconciled) {
          coverageConsistencyReconciled = true
          coverageEnvelope = {
            ...coverageEnvelope,
            value: reconciled.envelope,
            normalizedContent: buildCoverageEnvelopeYaml(reconciled.envelope),
          }
          structuredMeta = buildStructuredMetadata(structuredMeta, {
            repairApplied: true,
            repairWarnings: [reconciled.repairWarning],
          })
        }
      }

      interviewCoverageResolution = phase === 'interview' && interviewSnapshot
        ? resolveInterviewCoverageFollowUpResolution({
            status: coverageEnvelope.value.status,
            structuredFollowUps: coverageEnvelope.value.followUpQuestions,
            rawResponse: response,
            snapshot: interviewSnapshot,
            attempt,
            maxRetries: structuredRetryCount,
            maxFollowUps: interviewCoverageBudget?.total,
          })
        : null

      if (interviewCoverageResolution?.repairWarnings.length) {
        structuredMeta = buildStructuredMetadata(structuredMeta, {
          repairWarnings: interviewCoverageResolution.repairWarnings,
        })
      }

      // Only when the contradiction was left standing. Once it has been
      // reconciled the run accepts the result, and a `validationError` on an
      // accepted artifact reads as a rejection that never happened — the repair
      // warning recorded above is what actually describes it.
      if (coverageConsistencyError && !coverageConsistencyReconciled) {
        structuredMeta = buildStructuredMetadata(structuredMeta, {
          validationError: coverageConsistencyError,
        })
      }

      if (interviewCoverageResolution?.shouldRetry && interviewCoverageResolution.validationError) {
        structuredMeta = buildStructuredMetadata(structuredMeta, {
          autoRetryCount: attempt + 1,
          validationError: interviewCoverageResolution.validationError,
          retryDiagnostics: [resolveStructuredRetryDiagnostic({
            attempt: (structuredMeta.autoRetryCount ?? 0) + 1,
            rawResponse: response,
            validationError: interviewCoverageResolution.validationError,
          })],
        })
        promptParts = buildStructuredRetryPrompt([{ type: 'text', content: promptContent }], {
          validationError: interviewCoverageResolution.validationError,
          rawResponse: response,
          schemaReminder: promptTemplate.outputFormat,
        })
        continue
      }

      if (interviewCoverageResolution?.validationError) {
        structuredMeta = buildStructuredMetadata(structuredMeta, {
          validationError: interviewCoverageResolution.validationError,
        })
      }
      break
    }

    if (attempt >= structuredRetryCount) {
      structuredMeta = buildStructuredMetadata(structuredMeta, {
        autoRetryCount: attempt,
        validationError: coverageEnvelope.error,
        retryDiagnostics: [resolveStructuredRetryDiagnostic({
          attempt: (structuredMeta.autoRetryCount ?? 0) + 1,
          rawResponse: response,
          validationError: coverageEnvelope.error,
          retryDiagnostic: coverageEnvelope.retryDiagnostic,
        })],
      })
      const msg = `Coverage output failed validation after ${structuredRetryCount} structured retry attempt(s): ${coverageEnvelope.error}`
      const enrichedMsg = appendBlockedErrorDiagnosticsSummary(msg, latestOpenCodeDiagnostics?.diagnostics)
      emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', enrichedMsg)
      sendEvent({
        type: 'ERROR',
        message: enrichedMsg,
        codes: mergeErrorCodes(['COVERAGE_FAILED'], latestOpenCodeDiagnostics?.errorCodes ?? []),
        ...(latestOpenCodeDiagnostics?.diagnostics ? { diagnostics: latestOpenCodeDiagnostics.diagnostics } : {}),
      })
      return
    }

    structuredMeta = buildStructuredMetadata(structuredMeta, {
      autoRetryCount: attempt + 1,
      validationError: coverageEnvelope.error,
      retryDiagnostics: [resolveStructuredRetryDiagnostic({
        attempt: (structuredMeta.autoRetryCount ?? 0) + 1,
        rawResponse: response,
        validationError: coverageEnvelope.error,
        retryDiagnostic: coverageEnvelope.retryDiagnostic,
      })],
    })
    promptParts = buildStructuredRetryPrompt([{ type: 'text', content: promptContent }], {
      validationError: coverageEnvelope.error,
      rawResponse: response,
      schemaReminder: promptTemplate.outputFormat,
    })
  }

  if (!coverageEnvelope?.ok || !runResult) {
    const msg = 'Coverage verification finished without a parseable structured result.'
    const enrichedMsg = appendBlockedErrorDiagnosticsSummary(msg, latestOpenCodeDiagnostics?.diagnostics)
    emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', enrichedMsg)
    sendEvent({
      type: 'ERROR',
      message: enrichedMsg,
      codes: mergeErrorCodes(['COVERAGE_FAILED'], latestOpenCodeDiagnostics?.errorCodes ?? []),
      ...(latestOpenCodeDiagnostics?.diagnostics ? { diagnostics: latestOpenCodeDiagnostics.diagnostics } : {}),
    })
    return
  }

  persistUiArtifactCompanionArtifact(
    ticketId,
    stateLabel,
    `${phase}_coverage_input`,
    phase === 'interview'
      ? {
          ...(ticketState.interview ? { interview: ticketState.interview } : {}),
          ...(ticketState.userAnswers ? { userAnswers: ticketState.userAnswers } : {}),
        }
      : {
          ...(ticketState.beads ? { beads: ticketState.beads } : {}),
          ...(refinedContent ? { refinedContent } : {}),
        },
  )
  const detectedGaps = coverageEnvelope.value.status === 'gaps'
  const followUpQuestions = interviewCoverageResolution?.followUpQuestions ?? []
  const gapDisposition = resolveCoverageGapDisposition({
    phase,
    hasGaps: detectedGaps,
    isFinalAllowedRun,
    hasFollowUpQuestions: followUpQuestions.length > 0,
    remainingInterviewBudget: interviewCoverageResolution?.budget.remaining ?? interviewCoverageBudget?.remaining,
  })
  const shouldQueueInterviewFollowUps = gapDisposition.shouldLoopBack && phase === 'interview'

  insertPhaseArtifact(ticketId, {
    phase: stateLabel,
    artifactType: `${phase}_coverage`,
    content: JSON.stringify({
      winnerId,
      hasGaps: detectedGaps,
      coverageRunNumber,
      maxCoveragePasses: effectiveMaxCoveragePasses,
      limitReached: gapDisposition.limitReached,
      terminationReason: gapDisposition.terminationReason,
    }),
  })

  persistUiArtifactCompanionArtifact(ticketId, stateLabel, `${phase}_coverage`, {
    response,
    normalizedContent: coverageEnvelope.normalizedContent,
    parsed: coverageEnvelope.value,
    structuredOutput: structuredMeta,
    ...(phase === 'interview' && interviewCoverageResolution
      ? {
          followUpBudgetPercent: coverageSettings.coverageFollowUpBudgetPercent,
          followUpBudgetTotal: interviewCoverageResolution.budget.total,
          followUpBudgetUsed: interviewCoverageResolution.budget.used,
          followUpBudgetRemaining: interviewCoverageResolution.budget.remaining,
        }
      : phase === 'interview' && interviewCoverageBudget
        ? {
            followUpBudgetPercent: coverageSettings.coverageFollowUpBudgetPercent,
            followUpBudgetTotal: interviewCoverageBudget.total,
            followUpBudgetUsed: interviewCoverageBudget.used,
            followUpBudgetRemaining: interviewCoverageBudget.remaining,
          }
        : {}),
  })

  if (detectedGaps) {
    if (phase === 'interview') {
      if (!interviewSnapshot) {
        const msg = 'Coverage found interview gaps but no normalized interview session snapshot was available.'
        emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
        sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
        return
      }

      if (shouldQueueInterviewFollowUps) {
        const followUpBatch = buildCoverageFollowUpBatch(
          interviewSnapshot,
          followUpQuestions,
          buildCoverageFollowUpCommentary(response),
        )
        const updatedSnapshot = recordPreparedBatch(
          clearInterviewSessionBatch(interviewSnapshot),
          followUpBatch,
        )
        persistInterviewSession(ticketId, updatedSnapshot)

        // Clean up stale PROM4 session so handleInterviewQAStart can run on re-entry
        interviewQASessions.delete(ticketId)

        // Broadcast the follow-up batch so the frontend picks it up immediately
        broadcaster.broadcast(ticketId, 'needs_input', {
          ticketId,
          type: 'interview_batch',
          batch: followUpBatch,
        })
      }
    }

    if (phase === 'interview' && shouldQueueInterviewFollowUps) {
      emitModelSystemLog(
        ticketId,
        context.externalId,
        stateLabel,
        'info',
        `Coverage gaps detected by winning model ${winnerId}. Looping back for refinement.`,
        winnerId,
      )
      sendEvent({ type: 'GAPS_FOUND' })
      return
    }

    if (phase !== 'interview' && gapDisposition.shouldLoopBack) {
      emitModelSystemLog(
        ticketId,
        context.externalId,
        stateLabel,
        'info',
        `Coverage gaps detected by winning model ${winnerId}. Looping back for refinement.`,
        winnerId,
      )
      sendEvent({ type: 'GAPS_FOUND' })
      return
    }

    const reviewReason = phase === 'interview' && gapDisposition.terminationReason === 'follow_up_generation_failed'
      ? interviewCoverageResolution?.validationError
        ?? 'Coverage found interview gaps but produced no parseable follow-up questions.'
      : `Coverage gaps detected by winning model ${winnerId}, but ${describeCoverageTerminationReason(gapDisposition.terminationReason)}. Routing to approval with unresolved gaps for manual review.`
    emitModelSystemLog(
      ticketId,
      context.externalId,
      stateLabel,
      'info',
      reviewReason,
      winnerId,
    )
    sendEvent({ type: 'COVERAGE_LIMIT_REACHED' })
  } else {
    if (phase === 'interview') {
      try {
        const interviewPath = interviewSnapshot
          ? writeCanonicalInterview(context.externalId, ticketDir, interviewSnapshot)
          : resolve(ticketDir, 'interview.yaml')
        emitPhaseLog(ticketId, context.externalId, stateLabel, 'info',
          `Canonical interview.yaml ready at ${interviewPath}`)
      } catch (err) {
        console.error(`[runner] Failed to generate interview.yaml for ticket ${context.externalId}:`, err)
        emitPhaseLog(ticketId, context.externalId, stateLabel, 'info',
          `Failed to generate interview.yaml: ${getErrorMessage(err)}`)
      }
    }

    emitModelSystemLog(
      ticketId,
      context.externalId,
      stateLabel,
      'info',
      `Coverage verification passed (winning model: ${winnerId}).`,
      winnerId,
    )
    sendEvent({ type: 'COVERAGE_CLEAN' })
  }
}

export async function handleBeadsExpansion(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
  signal: AbortSignal,
) {
  const { worktreePath, ticket, ticketDir, relevantFiles } = loadTicketDirContext(context)
  const paths = getTicketPaths(ticketId)
  const stateLabel = 'EXPANDING_BEADS'
  const councilSettings = resolveCouncilRuntimeSettings(context)

  const winnerArtifact = getLatestPhaseArtifact(ticketId, 'beads_winner')
    ?? getLatestPhaseArtifact(ticketId, 'beads_votes')
  if (!winnerArtifact) {
    const msg = 'No persisted council winner found for beads — cannot determine winning model for expansion'
    emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
    sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
    return
  }

  let winnerId = ''
  try {
    const parsed = JSON.parse(winnerArtifact.content) as { winnerId?: string }
    winnerId = parsed.winnerId ?? ''
  } catch {
    const msg = 'Failed to parse winning model from persisted artifact for beads expansion'
    emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
    sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
    return
  }

  if (!winnerId) {
    const msg = 'No winnerId found in persisted artifact for beads expansion'
    emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
    sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
    return
  }

  const expansionInput = loadBeadsExpansionInput(ticketId)
  if (!expansionInput) {
    const msg = 'Beads expansion requires a validated semantic blueprint, but no coverage revision or refined artifact was found.'
    emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
    sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
    return
  }

  const { candidateContent, candidateVersion } = expansionInput

  const prdPath = resolve(ticketDir, 'prd.yaml')
  const diskPrdContent = existsSync(prdPath) ? readFileSync(prdPath, 'utf-8').trim() : ''
  if (!diskPrdContent) {
    const msg = 'Beads expansion requires an approved PRD, but prd.yaml was not available.'
    emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
    sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
    return
  }

  if (!paths) {
    const msg = 'Beads expansion requires a ticket workspace path, but it was not available.'
    emitPhaseLog(ticketId, context.externalId, stateLabel, 'error', msg)
    sendEvent({ type: 'ERROR', message: msg, codes: ['COVERAGE_FAILED'] })
    return
  }

  const ticketState: TicketState = {
    ticketId: context.externalId,
    title: context.title,
    description: ticket?.description ?? '',
    relevantFiles,
    prd: diskPrdContent,
    beads: candidateContent,
  }

  emitModelSystemLog(
    ticketId,
    context.externalId,
    stateLabel,
    'info',
    `Expanding validated Implementation Plan v${candidateVersion} into execution-ready beads.`,
    winnerId,
  )

  await finalizeBeadsCoverageExpansion({
    ticketId,
    externalId: context.externalId,
    stateLabel,
    winnerId,
    worktreePath,
    signal,
    councilSettings,
    ticketState,
    candidateContent,
    candidateVersion,
    structuredRetryCount: resolveStructuredRetryRuntimeSettings(context).structuredRetryCount,
  })

  sendEvent({ type: 'EXPANDED' })
}

export async function handlePreFlight(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
  signal: AbortSignal,
) {
  return withCommandLoggingAsync(
    ticketId, context.externalId, 'PRE_FLIGHT_CHECK',
    async () => {
      const beads = readTicketBeads(ticketId)
      const preFlightContext = {
        lockedMainImplementer: context.lockedMainImplementer,
        lockedMainImplementerVariant: context.lockedMainImplementerVariant,
        maxIterations: context.maxIterations,
      }
      const preFlightStreamState = createOpenCodeStreamState()
      const report = await runPreFlightChecks(adapter, ticketId, beads, preFlightContext, signal, undefined, {
        onOpenCodeStreamEvent: ({ session, modelId, event }) => {
          if (event.type !== 'session_error') return
          emitOpenCodeStreamEvent(
            ticketId,
            context.externalId,
            'PRE_FLIGHT_CHECK',
            modelId,
            session.id,
            event,
            preFlightStreamState,
          )
        },
      })
      throwIfAborted(signal, ticketId)

      // Emit individual per-check SYS log entries so each diagnostic result
      // is visible in the SYS tab (not only stored in the JSON artifact).
      const CHECK_RESULT_ICON: Record<string, string> = { pass: '✓', warning: '⚠', fail: '✗' }
      for (const check of report.checks) {
        const icon = CHECK_RESULT_ICON[check.result] ?? '✗'
        const isFail = check.result === 'fail'
        emitPhaseLog(
          ticketId,
          context.externalId,
          'PRE_FLIGHT_CHECK',
          isFail ? 'error' : 'info',
          `${icon} ${check.name}: ${check.message}`,
          {
            source: 'system',
            audience: 'all',
            kind: isFail ? 'error' : 'milestone',
          },
        )
      }

      insertPhaseArtifact(ticketId, {
        phase: 'PRE_FLIGHT_CHECK',
        artifactType: 'preflight_report',
        content: JSON.stringify(report),
      })

      if (!report.passed) {
        emitPhaseLog(ticketId, context.externalId, 'PRE_FLIGHT_CHECK', 'error', 'Pre-flight checks failed.', {
          failures: report.criticalFailures.map(check => check.message),
          source: 'system',
          audience: 'all',
          kind: 'error',
        })
        sendEvent({ type: 'CHECKS_FAILED', errors: report.criticalFailures.map(check => check.message) })
        return
      }

      updateTicketProgressFromBeads(ticketId, beads)
      emitPhaseLog(ticketId, context.externalId, 'PRE_FLIGHT_CHECK', 'info', `Pre-flight checks passed with ${beads.length} beads ready.`, {
        source: 'system',
        audience: 'all',
        kind: 'milestone',
      })
      sendEvent({ type: 'CHECKS_PASSED' })
    },
    (phase, type, content) => emitPhaseLog(ticketId, context.externalId, phase, type, content, { source: 'system', audience: 'all' }),
  )
}

const FINAL_TEST_RETRY_NOTES_ARTIFACT_TYPE = 'final_test_retry_notes'

function parseRuntimeEnvironment(content: string | null | undefined): RuntimeEnvironment | undefined {
  if (!content) return undefined
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    const candidate = parsed.runtime_environment ?? parsed.runtimeEnvironment
    const result = runtimeEnvironmentSchema.safeParse(candidate)
    return result.success ? result.data : undefined
  } catch {
    return undefined
  }
}

function resolveFinalTestRuntimeEnvironment(ticketId: string, worktreePath: string): RuntimeEnvironment | undefined {
  const profileArtifact = getLatestPhaseArtifact(
    ticketId,
    EXECUTION_SETUP_PROFILE_ARTIFACT_TYPE,
    'PREPARING_EXECUTION_ENV',
  )
  const artifactEnvironment = parseRuntimeEnvironment(profileArtifact?.content)
  if (artifactEnvironment) return artifactEnvironment

  const profileMirrorPath = resolve(worktreePath, EXECUTION_SETUP_PROFILE_MIRROR)
  if (existsSync(profileMirrorPath)) {
    try {
      return parseRuntimeEnvironment(readFileSync(profileMirrorPath, 'utf-8'))
    } catch {
      return undefined
    }
  }

  return undefined
}

function parseFinalTestRetryNotes(content: string | null | undefined): string[] {
  if (!content?.trim()) return []

  try {
    const parsed = JSON.parse(content) as { notes?: unknown } | string[] | string
    if (Array.isArray(parsed)) {
      return parsed
        .filter((note): note is string => typeof note === 'string')
        .map((note) => note.trim())
        .filter(Boolean)
    }
    if (typeof parsed === 'string') {
      return parsed.trim() ? [parsed.trim()] : []
    }
    if (Array.isArray(parsed?.notes)) {
      return parsed.notes
        .filter((note): note is string => typeof note === 'string')
        .map((note) => note.trim())
        .filter(Boolean)
    }
  } catch {
    // Fall back to treating the artifact as a single plain-text note.
  }

  const trimmed = content.trim()
  return trimmed ? [trimmed] : []
}

function serializeFinalTestRetryNotes(notes: string[]): string {
  return JSON.stringify({ notes }, null, 2)
}

function buildFinalTestRetryErrorContext(input: {
  attempt: number
  report: Awaited<ReturnType<typeof executeFinalTestCommands>>
  generation: FinalTestGenerationResult
}): PromptPart {
  const executedCommands = input.report.commands.length > 0
    ? input.report.commands.map((command) => {
      const status = command.timedOut
        ? `timed out after ${command.durationMs}ms`
        : `exit ${command.exitCode ?? 'unknown'}`
      return [
        `Command: ${command.displayCommand}`,
        `Command Spec: ${JSON.stringify(command.command)}`,
        `Result: ${status}`,
        command.stdout ? `STDOUT:\n${command.stdout.slice(0, COMMAND_OUTPUT_SLICE_LENGTH)}` : '',
        command.stderr ? `STDERR:\n${command.stderr.slice(0, COMMAND_OUTPUT_SLICE_LENGTH)}` : '',
      ].filter(Boolean).join('\n')
    }).join('\n\n')
    : 'No commands were executed.'

  return {
    type: 'text',
    source: 'error_context',
    content: [
      `## Final Test Attempt ${input.attempt}`,
      `Summary: ${input.generation.commandPlan.summary ?? input.report.summary ?? 'No summary provided.'}`,
      '',
      '## Planned Commands',
      input.generation.commandPlan.commands.length > 0
        ? input.generation.commandPlan.commands.join('\n')
        : 'No commands returned.',
      '',
      '## Test Files',
      input.report.testFiles.length > 0
        ? input.report.testFiles.join('\n')
        : 'No test files validated.',
      '',
      '## Execution Errors',
      input.report.errors.length > 0
        ? input.report.errors.join('\n')
        : input.generation.commandPlan.errors.join('\n') || 'No explicit error message recorded.',
      '',
      '## Command Output',
      executedCommands,
      '',
      '## Final Test Model Output (truncated)',
      input.report.modelOutput.slice(0, MODEL_OUTPUT_PREVIEW_LENGTH),
    ].join('\n'),
  }
}

async function generateFinalTestRetryNote(input: {
  ticketState: TicketState
  adapterArg: typeof adapter
  worktreePath: string
  attempt: number
  report: Awaited<ReturnType<typeof executeFinalTestCommands>>
  generation: FinalTestGenerationResult
  signal: AbortSignal
  model: string
  variant?: string
  timeoutMs: number
  onPromptDispatched?: (event: OpenCodePromptDispatchEvent) => void
  onPromptCompleted?: (event: OpenCodePromptCompletedEvent) => void
}): Promise<string> {
  const promptContent = buildPromptFromTemplate(PROM53, [
    ...buildMinimalContext('preflight', input.ticketState),
    buildFinalTestRetryErrorContext({
      attempt: input.attempt,
      report: input.report,
      generation: input.generation,
    }),
  ])

  try {
    const result = await runOpenCodePrompt({
      adapter: input.adapterArg,
      projectPath: input.worktreePath,
      parts: [{ type: 'text', content: promptContent }],
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      timeoutKind: 'ai_response',
      model: input.model,
      variant: input.variant,
      toolPolicy: PROM53.toolPolicy,
      onPromptDispatched: input.onPromptDispatched,
      onPromptCompleted: input.onPromptCompleted,
    })
    return result.response.trim()
  } catch (error) {
    throwIfCancelled(error, input.signal)
    throw error
  }
}

function validateFinalTestFiles(
  worktreePath: string,
  testFiles: string[],
  onMessage: (message: string) => void,
): string[] {
  const validated: string[] = []

  for (const filePath of testFiles) {
    if (filePath.includes('..')) {
      onMessage(`Rejected test file path with traversal: ${filePath}`)
      continue
    }
    const resolvedPath = resolve(worktreePath, filePath)
    if (!resolvedPath.startsWith(worktreePath)) {
      onMessage(`Rejected test file path outside worktree: ${filePath}`)
      continue
    }
    if (!existsSync(resolvedPath)) {
      onMessage(`AI-reported test file not found on disk: ${filePath}`)
    }
    validated.push(filePath)
  }

  return validated
}

function validateFinalCandidateFiles(
  worktreePath: string,
  modifiedFiles: string[],
  onMessage: (message: string) => void,
): string[] {
  const validated: string[] = []

  for (const filePath of modifiedFiles) {
    if (filePath.includes('..')) {
      onMessage(`Rejected modified file path with traversal: ${filePath}`)
      continue
    }
    const resolvedPath = resolve(worktreePath, filePath)
    if (!resolvedPath.startsWith(worktreePath)) {
      onMessage(`Rejected modified file path outside worktree: ${filePath}`)
      continue
    }
    if (!existsSync(resolvedPath)) {
      onMessage(`AI-reported modified file not found on disk: ${filePath}`)
      continue
    }
    validated.push(filePath)
  }

  return validated
}

export async function handleFinalTest(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
  signal: AbortSignal,
) {
  if (isMockOpenCodeMode()) {
    await handleMockExecutionUnsupported(ticketId, context, 'RUNNING_FINAL_TEST', sendEvent)
    return
  }

  return withCommandLoggingAsync(
    ticketId, context.externalId, 'RUNNING_FINAL_TEST',
    async () => {
  const { worktreePath, ticket, relevantFiles } = loadTicketDirContext(context)
  const paths = getTicketPaths(ticketId)
  const ticketDir = paths?.ticketDir
  const ticketState: TicketState = {
    ticketId: context.externalId,
    title: context.title,
    description: ticket?.description ?? '',
    relevantFiles,
  }

  if (ticketDir) {
    const interviewPath = resolve(ticketDir, 'interview.yaml')
    const prdPath = resolve(ticketDir, 'prd.yaml')
    const beadsPath = paths?.beadsPath

    if (existsSync(interviewPath)) {
      try { ticketState.interview = readFileSync(interviewPath, 'utf-8') } catch { /* ignore */ }
    }
    if (existsSync(prdPath)) {
      try { ticketState.prd = readFileSync(prdPath, 'utf-8') } catch { /* ignore */ }
    }
    if (existsSync(beadsPath)) {
      try { ticketState.beads = readFileSync(beadsPath, 'utf-8') } catch { /* ignore */ }
    }
  }

  const existingRetryNotesArtifact = getLatestPhaseArtifact(
    ticketId,
    FINAL_TEST_RETRY_NOTES_ARTIFACT_TYPE,
    'RUNNING_FINAL_TEST',
  )
  ticketState.finalTestNotes = parseFinalTestRetryNotes(existingRetryNotesArtifact?.content)
  const finalTestModelId = context.lockedMainImplementer
  if (!finalTestModelId) {
    throw new Error('No locked main implementer is configured for final tests')
  }
  const executionSettings = resolveExecutionRuntimeSettings(context)
  const aiResponseSettings = resolveAiResponseRuntimeSettings(context)
  const phaseStartCommit = recordWorktreeStartCommit(worktreePath)
  const runtimeEnvironment = resolveFinalTestRuntimeEnvironment(ticketId, worktreePath)
  let finalTestBaselineDirtyFiles: FinalTestDirtyFile[] = captureFinalTestDirtyFiles(worktreePath)
  let finalTestSessionId = ''
  const streamStates = new Map<string, OpenCodeStreamState>()
  const report = await executeFinalTestWithRetries(
    adapter,
    async () => buildMinimalContext('final_test', ticketState),
    worktreePath,
    signal,
    {
      ticketId,
      model: finalTestModelId,
      variant: context.lockedMainImplementerVariant ?? undefined,
      maxIterations: executionSettings.maxIterations,
      timeoutMs: executionSettings.perIterationTimeoutMs,
      aiResponseTimeoutMs: aiResponseSettings.timeoutMs,
      structuredRetryCount: resolveStructuredRetryRuntimeSettings(context).structuredRetryCount,
      initialAttempt: ticketState.finalTestNotes.length + 1,
    },
    {
      executePlan: async ({ attempt, generation }) => {
        const {
          output,
          commandPlan,
          structuredOutput: planStructuredOutput,
          rawAttempts,
        } = generation

        const validatedTestFiles = validateFinalTestFiles(
          worktreePath,
          commandPlan.testFiles,
          (message) => {
            emitPhaseLog(
              ticketId,
              context.externalId,
              'RUNNING_FINAL_TEST',
              'info',
              `Attempt ${attempt}: ${message}`,
            )
          },
        )
        const validatedModifiedFiles = validateFinalCandidateFiles(
          worktreePath,
          commandPlan.modifiedFiles,
          (message) => {
            emitPhaseLog(
              ticketId,
              context.externalId,
              'RUNNING_FINAL_TEST',
              'info',
              `Attempt ${attempt}: ${message}`,
            )
          },
        )

        if (validatedTestFiles.length > 0) {
          emitAiMilestone(
            ticketId,
            context.externalId,
            'RUNNING_FINAL_TEST',
            `Attempt ${attempt}: test files created/modified: ${validatedTestFiles.join(', ')}`,
            `${ticketId}:final-test-files:${attempt}`,
            {
              attempt,
              testFiles: validatedTestFiles,
              source: `model:${finalTestModelId}`,
            },
          )
        }

        if (validatedModifiedFiles.length > 0) {
          emitAiMilestone(
            ticketId,
            context.externalId,
            'RUNNING_FINAL_TEST',
            `Attempt ${attempt}: final candidate files created/modified: ${validatedModifiedFiles.join(', ')}`,
            `${ticketId}:final-candidate-files:${attempt}`,
            {
              attempt,
              modifiedFiles: validatedModifiedFiles,
              source: `model:${finalTestModelId}`,
            },
          )
        }

        if (commandPlan.commands.length === 0) {
          return {
            status: 'failed' as const,
            passed: false,
            checkedAt: new Date().toISOString(),
            plannedBy: finalTestModelId,
            modelOutput: output,
            testFiles: validatedTestFiles,
            modifiedFiles: validatedModifiedFiles,
            fileEffects: commandPlan.fileEffects,
            testsCount: commandPlan.testsCount,
            commands: [],
            errors: commandPlan.errors,
            planStructuredOutput,
            rawAttempts,
          }
        }

        return await executeFinalTestCommands({
          commands: commandPlan.commands,
          cwd: worktreePath,
          timeoutMs: executionSettings.perIterationTimeoutMs,
          plannedBy: finalTestModelId,
          ...(commandPlan.summary ? { summary: commandPlan.summary } : {}),
          testFiles: validatedTestFiles,
          modifiedFiles: validatedModifiedFiles,
          fileEffects: commandPlan.fileEffects,
          testsCount: commandPlan.testsCount,
          modelOutput: output,
          planStructuredOutput,
          rawAttempts,
          runtimeEnvironment,
        })
      },
      generateRetryNote: async ({ attempt, report, generation }) => {
        return await generateFinalTestRetryNote({
          ticketState,
          adapterArg: adapter,
          worktreePath,
          attempt,
          report,
          generation,
          signal,
          model: finalTestModelId,
          variant: context.lockedMainImplementerVariant ?? undefined,
          timeoutMs: aiResponseSettings.timeoutMs,
          onPromptDispatched: (event) => {
            emitOpenCodePromptLog(
              ticketId,
              context.externalId,
              'RUNNING_FINAL_TEST',
              finalTestModelId,
              event,
            )
          },
          onPromptCompleted: (event) => {
            emitOpenCodeSessionLogs(
              ticketId,
              context.externalId,
              'RUNNING_FINAL_TEST',
              finalTestModelId,
              event.session.id,
              'final_test_retry_note',
              event.response,
              event.messages,
            )
          },
        })
      },
      onAttemptStart: (attempt) => {
        finalTestBaselineDirtyFiles = captureFinalTestDirtyFiles(worktreePath)
        emitPhaseLog(
          ticketId,
          context.externalId,
          'RUNNING_FINAL_TEST',
          'info',
          executionSettings.maxIterations > 0
            ? `Starting final test attempt ${attempt} of ${executionSettings.maxIterations}.`
            : `Starting final test attempt ${attempt} with unlimited retry budget.`,
        )
      },
      onAttemptComplete: ({ attempt, report }) => {
        emitPhaseLog(
          ticketId,
          context.externalId,
          'RUNNING_FINAL_TEST',
          'test_result',
          report.passed
            ? `Final test attempt ${attempt} passed (${report.commands.length} command${report.commands.length === 1 ? '' : 's'}).`
            : `Final test attempt ${attempt} failed: ${report.errors.join('; ') || 'no commands were executed'}`,
          {
            audience: 'all',
            kind: 'test',
            op: 'append',
            source: `model:${finalTestModelId}`,
            modelId: finalTestModelId,
            streaming: false,
            attempt,
          },
        )
      },
      onSessionCreated: (sessionId, attempt) => {
        finalTestSessionId = sessionId
        emitAiMilestone(
          ticketId,
          context.externalId,
          'RUNNING_FINAL_TEST',
          `Final test attempt ${attempt} session created for ${finalTestModelId} (session=${sessionId}).`,
          `${sessionId}:final-test-created:${attempt}`,
          {
            attempt,
            modelId: finalTestModelId,
            sessionId,
            source: `model:${finalTestModelId}`,
          },
        )
      },
      onOpenCodeStreamEvent: ({ sessionId, event }) => {
        const streamState = streamStates.get(sessionId) ?? createOpenCodeStreamState()
        streamStates.set(sessionId, streamState)
        emitOpenCodeStreamEvent(
          ticketId,
          context.externalId,
          'RUNNING_FINAL_TEST',
          finalTestModelId,
          sessionId,
          event,
          streamState,
        )
      },
      onFailedAttempt: ({ attempt, note, notes, canRetry }) => {
        ticketState.finalTestNotes = notes
        upsertLatestPhaseArtifact(
          ticketId,
          FINAL_TEST_RETRY_NOTES_ARTIFACT_TYPE,
          'RUNNING_FINAL_TEST',
          serializeFinalTestRetryNotes(notes),
        )
        emitPhaseLog(
          ticketId,
          context.externalId,
          'RUNNING_FINAL_TEST',
          'info',
          canRetry
            ? `Attempt ${attempt}: appended a final-test retry note for attempt ${attempt + 1}.`
            : `Attempt ${attempt}: appended a final-test retry note before blocking.`,
          {
            note,
          },
        )
      },
      beforeRetry: ({ nextAttempt }) => {
        resetWorktreeToCommit(worktreePath, phaseStartCommit, {
          preservePaths: [...WORKTREE_RESET_PRESERVE_PATHS],
        })
        emitPhaseLog(
          ticketId,
          context.externalId,
          'RUNNING_FINAL_TEST',
          'info',
          `Reset worktree to final-test start commit before attempt ${nextAttempt}.`,
          {
            commit: phaseStartCommit,
            nextAttempt,
          },
        )
      },
      onRetriesExhausted: ({ attempt }) => {
        emitPhaseLog(
          ticketId,
          context.externalId,
          'RUNNING_FINAL_TEST',
          'error',
          `Final-test retries exhausted after ${attempt} attempt${attempt === 1 ? '' : 's'}.`,
        )
      },
      onPromptDispatched: ({ event }) => {
        emitOpenCodePromptLog(
          ticketId,
          context.externalId,
          'RUNNING_FINAL_TEST',
          finalTestModelId,
          event,
        )
      },
      onPromptCompleted: ({ stage, event }) => {
        emitOpenCodeSessionLogs(
          ticketId,
          context.externalId,
          'RUNNING_FINAL_TEST',
          finalTestModelId,
          event.session.id,
          stage,
          event.response,
          event.messages,
          streamStates.get(event.session.id),
        )
      },
    },
  )
  throwIfAborted(signal, ticketId)

  insertPhaseArtifact(ticketId, {
    phase: 'RUNNING_FINAL_TEST',
    artifactType: 'final_test_report',
    content: JSON.stringify(report),
  })
  emitPhaseLog(
    ticketId,
    context.externalId,
    'RUNNING_FINAL_TEST',
    'test_result',
    report.passed
      ? `Final test commands passed after ${report.attempt ?? 1} attempt${report.attempt === 1 ? '' : 's'} (${report.commands.length} command${report.commands.length === 1 ? '' : 's'}).`
      : `Final test commands failed after ${report.attempt ?? 1} attempt${report.attempt === 1 ? '' : 's'}: ${report.errors.join('; ') || 'no commands were executed'}`,
    {
    audience: 'all',
    kind: 'test',
    op: 'append',
    source: `model:${finalTestModelId}`,
    modelId: finalTestModelId,
    streaming: false,
    },
  )
  if (report.passed) {
    const dirtyFilesAfterTesting = captureFinalTestDirtyFiles(
      worktreePath,
      report.fileEffects.map((effect) => effect.path),
    )
    const setupExcludedRoots = getExecutionSetupCommitExcludedRoots(worktreePath)
    let fileEffectsAudit = buildFinalTestFileEffectsAudit({
      baselineDirtyFiles: finalTestBaselineDirtyFiles,
      dirtyFilesAfterTesting,
      declaredEffects: report.fileEffects,
      setupExcludedRoots,
    })

    const classificationRequiredFiles = [...fileEffectsAudit.classificationRequiredFiles]
    if (classificationRequiredFiles.length > 0) {
      const fallbackWarning = finalTestSessionId
        ? ''
        : 'The final-test planning session was unavailable for the automatic file-classification retry.'
      try {
        if (!finalTestSessionId) throw new Error(fallbackWarning)

        emitPhaseLog(
          ticketId,
          context.externalId,
          'RUNNING_FINAL_TEST',
          'info',
          `Requesting one automatic classification retry for ${classificationRequiredFiles.length} undeclared untracked file${classificationRequiredFiles.length === 1 ? '' : 's'}.`,
        )
        const retryResult = await runOpenCodeSessionPrompt({
          adapter,
          session: { id: finalTestSessionId },
          parts: [{
            type: 'text',
            content: [
              'The final-test commands already passed. Do not run commands or modify files.',
              'Your accepted response did not classify every untracked file left by final testing.',
              'Return exactly one corrected <FINAL_TEST_COMMANDS>...</FINAL_TEST_COMMANDS> block.',
              'Keep the accepted commands, test_files, modified_files, and summary unchanged.',
              'Add one file_effects entry for every path below, using candidate, temporary, or unexpected.',
              'Use candidate only for permanent ticket work that belongs in the pull request.',
              '',
              'Files requiring classification:',
              ...classificationRequiredFiles.map((file) => `- ${file}`),
              '',
              'Previously accepted response:',
              report.modelOutput,
            ].join('\n'),
          }],
          signal,
          timeoutMs: aiResponseSettings.timeoutMs,
          timeoutKind: 'ai_response',
          model: finalTestModelId,
          erroredSessionPolicy: 'discard_errored_session_output',
          toolPolicy: 'disabled',
          onStreamEvent: (event) => {
            const streamState = streamStates.get(finalTestSessionId) ?? createOpenCodeStreamState()
            streamStates.set(finalTestSessionId, streamState)
            emitOpenCodeStreamEvent(
              ticketId,
              context.externalId,
              'RUNNING_FINAL_TEST',
              finalTestModelId,
              finalTestSessionId,
              event,
              streamState,
            )
          },
          onPromptDispatched: (event) => {
            emitOpenCodePromptLog(
              ticketId,
              context.externalId,
              'RUNNING_FINAL_TEST',
              finalTestModelId,
              event,
            )
          },
          onPromptCompleted: (event) => {
            emitOpenCodeSessionLogs(
              ticketId,
              context.externalId,
              'RUNNING_FINAL_TEST',
              finalTestModelId,
              event.session.id,
              'final_test_file_effects_retry',
              event.response,
              event.messages,
              streamStates.get(event.session.id),
            )
          },
        })
        throwIfAborted(signal, ticketId)

        const repairedPlan = parseFinalTestCommands(retryResult.response)
        if (repairedPlan.errors.length > 0) {
          throw new Error(repairedPlan.validationError ?? repairedPlan.errors.join('; '))
        }

        const normalizeEffectPath = (path: string) => path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
        const requiredPaths = new Set(classificationRequiredFiles)
        const repairedByPath = new Map(
          repairedPlan.fileEffects.map((effect) => [normalizeEffectPath(effect.path), effect]),
        )
        const missingPaths = classificationRequiredFiles.filter((file) => !repairedByPath.has(file))
        if (missingPaths.length > 0) {
          throw new Error(`Classification retry omitted: ${missingPaths.join(', ')}`)
        }

        const retainedEffects = report.fileEffects.filter(
          (effect) => !requiredPaths.has(normalizeEffectPath(effect.path)),
        )
        const repairedEffects: FinalTestFileEffect[] = classificationRequiredFiles
          .map((file) => repairedByPath.get(file))
          .filter((effect): effect is FinalTestFileEffect => Boolean(effect))
        fileEffectsAudit = buildFinalTestFileEffectsAudit({
          baselineDirtyFiles: finalTestBaselineDirtyFiles,
          dirtyFilesAfterTesting,
          declaredEffects: [...retainedEffects, ...repairedEffects],
          setupExcludedRoots,
          classificationRetry: {
            status: 'resolved',
            requestedFiles: classificationRequiredFiles,
          },
        })
        emitPhaseLog(
          ticketId,
          context.externalId,
          'RUNNING_FINAL_TEST',
          'info',
          `Automatic file-classification retry resolved ${classificationRequiredFiles.length} file${classificationRequiredFiles.length === 1 ? '' : 's'}.`,
        )
      } catch (error) {
        const warning = [
          `Automatic file-classification retry did not resolve ${classificationRequiredFiles.length} file${classificationRequiredFiles.length === 1 ? '' : 's'}.`,
          getErrorMessage(error),
          'The files remain local-only and delivery will continue.',
        ].filter(Boolean).join(' ')
        fileEffectsAudit = {
          ...fileEffectsAudit,
          classificationRetry: {
            status: 'fallback',
            requestedFiles: classificationRequiredFiles,
            warning,
          },
          warnings: [...fileEffectsAudit.warnings, warning],
          message: `Final-test file effects were resolved with ${fileEffectsAudit.warnings.length + 1} warning(s).`,
        }
        emitPhaseLog(
          ticketId,
          context.externalId,
          'RUNNING_FINAL_TEST',
          'info',
          warning,
        )
      }
    }
    if (fileEffectsAudit.classificationRetry.status === 'resolved') {
      upsertLatestPhaseArtifact(
        ticketId,
        'final_test_report',
        'RUNNING_FINAL_TEST',
        JSON.stringify({
          ...report,
          fileEffects: fileEffectsAudit.declaredEffects,
        }),
      )
    }
    insertPhaseArtifact(ticketId, {
      phase: 'RUNNING_FINAL_TEST',
      artifactType: FINAL_TEST_FILE_EFFECTS_AUDIT_ARTIFACT,
      content: JSON.stringify(fileEffectsAudit),
    })
    emitPhaseLog(
      ticketId,
      context.externalId,
      'RUNNING_FINAL_TEST',
      'info',
      `Final-test file effects audit resolved ${fileEffectsAudit.producedByFinalTesting.length} dirty file effect${fileEffectsAudit.producedByFinalTesting.length === 1 ? '' : 's'} (${fileEffectsAudit.candidateFiles.length} candidate, ${fileEffectsAudit.localOnlyFiles.length} local-only).`,
      {
        audit: fileEffectsAudit,
      },
    )
    emitPhaseLog(ticketId, context.externalId, 'RUNNING_FINAL_TEST', 'info', `Final tests passed after ${report.attempt ?? 1} attempt${report.attempt === 1 ? '' : 's'} (${report.commands.length} command${report.commands.length === 1 ? '' : 's'}).`)
    sendEvent({ type: 'TESTS_PASSED' })
    return
  }

  emitPhaseLog(ticketId, context.externalId, 'RUNNING_FINAL_TEST', 'error', `Final tests failed after ${report.attempt ?? 1} attempt${report.attempt === 1 ? '' : 's'}.`, {
    errors: report.errors,
    retryNotes: report.retryNotes,
  })
  sendEvent({ type: 'TESTS_FAILED' })
    },
    (phase, type, content) => emitPhaseLog(ticketId, context.externalId, phase, type, content, { source: 'system', audience: 'all' }),
  )
}

export async function handleMockCoverage(
  ticketId: string,
  context: TicketContext,
  phase: 'interview' | 'prd' | 'beads',
  sendEvent: (event: TicketEvent) => void,
) {
  const { members } = resolveCouncilMembers(context)
  const winnerId = readMockInterviewWinnerId(ticketId, members[0]?.modelId ?? 'mock-model-1')
  const stateLabel = getCoverageStateLabel(phase)
  const coverageSettings = resolveCoverageRuntimeSettings(context)
  const configuredMaxCoveragePasses = phase === 'interview'
    ? coverageSettings.maxCoveragePasses
    : phase === 'prd'
      ? coverageSettings.maxPrdCoveragePasses
      : coverageSettings.maxBeadsCoveragePasses
  const effectiveMaxCoveragePasses = getVersionedCoveragePassLimit(phase, configuredMaxCoveragePasses)
  const coverageRunNumber = countPhaseArtifacts(ticketId, `${phase}_coverage`, stateLabel) + 1
  const interviewSnapshot = phase === 'interview'
    ? readInterviewSessionSnapshotArtifact(ticketId)
    : null

  persistUiArtifactCompanionArtifact(ticketId, stateLabel, `${phase}_coverage`, {
    response: 'mock coverage clean',
    normalizedContent: 'mock coverage clean',
    parsed: { status: 'clean', gaps: [] },
    ...(phase === 'interview' && interviewSnapshot
      ? {
          followUpBudgetPercent: coverageSettings.coverageFollowUpBudgetPercent,
          followUpBudgetTotal: calculateFollowUpLimit(interviewSnapshot.maxInitialQuestions, coverageSettings.coverageFollowUpBudgetPercent),
          followUpBudgetUsed: countCoverageFollowUpQuestions(interviewSnapshot),
          followUpBudgetRemaining: Math.max(
            0,
            calculateFollowUpLimit(interviewSnapshot.maxInitialQuestions, coverageSettings.coverageFollowUpBudgetPercent)
              - countCoverageFollowUpQuestions(interviewSnapshot),
          ),
        }
      : {}),
  })

  insertPhaseArtifact(ticketId, {
    phase: stateLabel,
    artifactType: `${phase}_coverage`,
    content: JSON.stringify({
      winnerId,
      hasGaps: false,
      coverageRunNumber,
      maxCoveragePasses: effectiveMaxCoveragePasses,
      limitReached: false,
      terminationReason: 'clean',
    }),
  })

  if (phase === 'interview') {
    const paths = getTicketPaths(ticketId)
    if (paths && interviewSnapshot) {
      writeCanonicalInterview(context.externalId, paths.ticketDir, interviewSnapshot)
    }
  }

  emitPhaseLog(ticketId, context.externalId, stateLabel, 'info', `Mock ${phase} coverage passed.`)
  sendEvent({ type: 'COVERAGE_CLEAN' })
}

export async function handleMockBeadsExpansion(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
) {
  const { members } = resolveCouncilMembers(context)
  const winnerId = readMockBeadsWinnerId(ticketId, members[0]?.modelId ?? 'mock-model-1')
  const paths = getTicketPaths(ticketId)
  if (!paths) throw new Error(`Ticket workspace not initialized: missing ticket paths for ${context.externalId}`)

  const beadSubsets = buildMockBeadSubsets(context)
  const mockExpansionCandidates = beadSubsets.map((subset, index) => {
    const prevSubset = beadSubsets[index - 1]
    return {
      id: `${context.externalId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${subset.id}`,
      issueType: 'feature',
      labels: [`ticket:${context.externalId}`],
      dependencies: {
        blocked_by: prevSubset
          ? [`${context.externalId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${prevSubset.id}`]
          : [],
        blocks: [],
      },
      targetFiles: [],
    }
  })
  const hydratedBeads = hydrateExpandedBeads(beadSubsets, mockExpansionCandidates, context.externalId)
  const expandedContent = mockExpansionCandidates.map((bead) => JSON.stringify(bead)).join('\n')
  const hydratedContent = hydratedBeads.map((bead) => JSON.stringify(bead)).join('\n')

  insertPhaseArtifact(ticketId, {
    phase: 'EXPANDING_BEADS',
    artifactType: 'beads_expanded',
    content: JSON.stringify({
      winnerId,
      semanticPlanContent: buildYamlDocument({ beads: beadSubsets }),
      refinedContent: hydratedContent,
      expandedContent,
      candidateVersion: 1,
    }),
  })
  persistUiArtifactCompanionArtifact(ticketId, 'EXPANDING_BEADS', 'beads_expanded', {
    structuredOutput: null,
    draftMetrics: {
      beadCount: beadSubsets.length,
      totalTestCount: beadSubsets.reduce((sum, b) => sum + b.tests.length, 0),
      totalAcceptanceCriteriaCount: beadSubsets.reduce((sum, b) => sum + b.acceptanceCriteria.length, 0),
    },
    pipelineSteps: BEADS_PIPELINE_STEPS,
    candidateVersion: 1,
  })

  writeTicketBeads(ticketId, hydratedBeads)
  updateTicketProgressFromBeads(ticketId, hydratedBeads)
  clearContextCache(context.externalId)

  emitPhaseLog(ticketId, context.externalId, 'EXPANDING_BEADS', 'info', `Mock beads expansion completed. Persisted ${hydratedBeads.length} execution-ready beads.`)
  sendEvent({ type: 'EXPANDED' })
}
