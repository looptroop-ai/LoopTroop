import { useId, useMemo, useState } from 'react'
import { ChevronRight, AlertTriangle } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLogs } from '@/context/useLogContext'
import type { LogEntry } from '@/context/LogContext'
import { getStatusUserLabel, WORKFLOW_GROUPS } from '@/lib/workflowMeta'
import { cn } from '@/lib/utils'
import type { Ticket } from '@/hooks/useTickets'
import { type DBartifact, useTicketArtifacts } from '@/hooks/useTicketArtifacts'
import { useTicketPhaseAttempts, type TicketPhaseAttempt } from '@/hooks/useTicketPhaseAttempts'
import { getTicketRuntime } from '@/lib/ticketNormalization'
import { sanitizeErrorForDisplay } from '@/lib/errorDisplay'
import type { TicketErrorOccurrence } from '@/lib/errorOccurrences'
import { findLatestArtifactByType, findLatestCompanionArtifact, parseArtifactCompanionPayload } from '@/components/workspace/artifactCompanionUtils'
import { buildCoverageArtifactContent, parseCoverageArtifact } from '@/components/workspace/phaseArtifactTypes'
import type { WorkflowContextKey } from '@shared/workflowMeta'
import { getWorkflowPhaseMeta } from '@shared/workflowMeta'
import { ActiveBeadCountdown } from '../navigator/ActiveBeadCountdown'

/**
 * Human-readable labels and tooltip descriptions for each workflow context key,
 * shown in the "Context" section of the Details dialog.
 *
 * NOTE: `votes` is defined here for completeness but is not currently referenced
 * by any phase’s `contextSummary` array.
 */
const CONTEXT_KEY_LABELS: Record<WorkflowContextKey, { label: string; description: string }> = {
  ticket_details: { label: 'Ticket Details', description: 'The saved ticket title and full description text. This is the root user-requirement context for planning; priority, project data, settings, and structured provenance remain informational and are not included.' },
  relevant_files: { label: 'Relevant Files', description: 'Source file contents identified as relevant by the AI scan phase. Includes file paths, content excerpts, relevance ratings, and rationales explaining why each file matters to this ticket.' },
  drafts: { label: 'Competing Drafts', description: 'The set of independently generated candidate drafts from each council member. Used during voting to compare approaches side-by-side and during refinement to merge the strongest ideas from losing drafts into the winner. After drafting, Raw views show the validated draft content that downstream phases consume.' },
  interview: { label: 'Interview Results', description: 'The canonical interview artifact containing the finalized questions, user answers, skip decisions, and any follow-up rounds. This is the approved version that downstream phases treat as authoritative.' },
  full_answers: { label: 'Full Answers', description: 'Model-generated interview results where skipped questions have been filled in by the AI. PRD coverage uses only the winning model\'s Full Answers artifact as its canonical source.' },
  user_answers: { label: 'User Answers', description: 'The raw user responses collected during the interview loop, including answer text, skip/unskip decisions, and batch submission history across initial and follow-up rounds.' },
  votes: { label: 'Council Votes', description: 'Structured vote payloads from each council member, including rubric scores, rankings, and outcome metadata. Used to select the winning draft and provide audit transparency.' },
  prd: { label: 'PRD', description: 'The product requirements document artifact — either the latest coverage-checked candidate or the user-approved version. Contains requirements, acceptance criteria, edge cases, and test intent.' },
  beads: { label: 'Beads Plan', description: 'The current beads artifact. During coverage phases this contains the semantic blueprint with task descriptions and acceptance criteria. After the expansion step, it contains execution-ready bead records with dependency graphs, commands, and runtime fields.' },
  beads_draft: { label: 'Semantic Blueprint', description: 'The refined semantic beads blueprint before final expansion. Contains high-level task decomposition, acceptance criteria, and test intent without execution-specific fields. Used as input to the expansion step that produces execution-ready bead records.' },
  tests: { label: 'Verification Tests', description: 'Coverage and final test context including test commands, expected outcomes, and test intent derived from the PRD and beads plan. Used during self-testing and integration phases.' },
  bead_data: { label: 'Current Bead Data', description: 'The active bead specification being executed, including its description, acceptance criteria, dependencies, file targets, and any retry/iteration context from previous attempts.' },
  bead_notes: { label: 'Bead Note Histories', description: 'Three append-only histories for the current bead: Failed Iteration Notes, User Retry Notes, and Finalization Failure Notes. Their separate labels preserve the source and purpose of each entry.' },
  execution_setup_plan: { label: 'Execution Setup Plan', description: 'The user-reviewable workspace-preparation artifact drafted after pre-flight. It contains an explicit readiness assessment, any still-required setup steps, discovered project command families, and the quality-gate policy the execution setup phase should start from.' },
  execution_setup_plan_notes: { label: 'Execution Setup Plan Notes', description: 'Append-only commentary and regenerate notes captured while revising the execution setup plan before approval.' },
  execution_setup_profile: { label: 'Execution Setup Profile', description: 'A reusable runtime profile produced by the execution setup phase. It records setup roots, tooling probes, provisioning-attempt evidence when applicable, discovered command families, reusable artifacts, and the quality-gate policy; coding and final testing can reuse it when needed.' },
  execution_setup_notes: { label: 'Execution Setup Notes', description: 'Append-only retry notes from failed execution setup attempts. These help the next setup retry avoid repeating the same environment mistakes or policy violations.' },
  final_test_notes: { label: 'Final Test Notes', description: 'Append-only retry notes from failed final-test attempts. These help the next final-test generation avoid repeating the same verification mistakes.' },
  manual_qa_previous: { label: 'Previous Manual QA', description: 'The latest completed Manual QA checklist and results used to preserve item lineage, recheck affected behavior, and retain unaffected historical passes across QA fix rounds.' },
  manual_qa_checklist: { label: 'Manual QA Checklist', description: 'The immutable generated checklist for the active version, including user-run prerequisites, actions, expected results, advisory PRD coverage, and stable cross-round item lineage.' },
  manual_qa_results: { label: 'Manual QA Results', description: 'The submitted pass, fail, waiver, improvement, evidence-reference, or skip outcomes. Evidence binaries remain in ticket-owned storage and are never embedded in prompt context.' },
  error_context: { label: 'Error Context', description: 'Failure context from the most recent blocked error, including the error message, error codes, the phase where the failure occurred, occurrence timing, and diagnostic details to help with retry decisions.' },
}

const KANBAN_PHASE_LABELS: Record<string, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  needs_input: 'Needs Input',
  done: 'Done',
}

interface WorkspacePhaseSummaryProps {
  phase: string
  ticket: Ticket
  errorMessage?: string | null
  errorOccurrence?: TicketErrorOccurrence | null
}

type CoveragePhase = 'VERIFYING_INTERVIEW_COVERAGE' | 'VERIFYING_PRD_COVERAGE' | 'VERIFYING_BEADS_COVERAGE'
type VersionedCoveragePhase = 'VERIFYING_PRD_COVERAGE' | 'VERIFYING_BEADS_COVERAGE'

/** Phase-specific metadata for the two coverage phases that track versioned candidate revisions. */
const COVERAGE_PHASE_META: Record<VersionedCoveragePhase, {
  coverageArtifactType: 'prd_coverage' | 'beads_coverage'
  coverageInputArtifactType: 'prd_coverage_input' | 'beads_coverage_input'
  coverageRevisionArtifactType: 'prd_coverage_revision' | 'beads_coverage_revision'
  candidateLabel: 'PRD Candidate' | 'Implementation Plan'
}> = {
  VERIFYING_PRD_COVERAGE: {
    coverageArtifactType: 'prd_coverage',
    coverageInputArtifactType: 'prd_coverage_input',
    coverageRevisionArtifactType: 'prd_coverage_revision',
    candidateLabel: 'PRD Candidate',
  },
  VERIFYING_BEADS_COVERAGE: {
    coverageArtifactType: 'beads_coverage',
    coverageInputArtifactType: 'beads_coverage_input',
    coverageRevisionArtifactType: 'beads_coverage_revision',
    candidateLabel: 'Implementation Plan',
  },
}

const COVERAGE_ARTIFACT_TYPES: Record<CoveragePhase, {
  coverageArtifactType: 'interview_coverage' | 'prd_coverage' | 'beads_coverage'
  coverageInputArtifactType: 'interview_coverage_input' | 'prd_coverage_input' | 'beads_coverage_input'
  coverageRevisionArtifactType?: 'prd_coverage_revision' | 'beads_coverage_revision'
}> = {
  VERIFYING_INTERVIEW_COVERAGE: {
    coverageArtifactType: 'interview_coverage',
    coverageInputArtifactType: 'interview_coverage_input',
  },
  VERIFYING_PRD_COVERAGE: {
    coverageArtifactType: 'prd_coverage',
    coverageInputArtifactType: 'prd_coverage_input',
    coverageRevisionArtifactType: 'prd_coverage_revision',
  },
  VERIFYING_BEADS_COVERAGE: {
    coverageArtifactType: 'beads_coverage',
    coverageInputArtifactType: 'beads_coverage_input',
    coverageRevisionArtifactType: 'beads_coverage_revision',
  },
}

function isCoveragePhase(phase: string): phase is CoveragePhase {
  return phase === 'VERIFYING_INTERVIEW_COVERAGE'
    || phase === 'VERIFYING_PRD_COVERAGE'
    || phase === 'VERIFYING_BEADS_COVERAGE'
}

function isVersionedCoveragePhase(phase: string): phase is VersionedCoveragePhase {
  return phase === 'VERIFYING_PRD_COVERAGE' || phase === 'VERIFYING_BEADS_COVERAGE'
}

/** Normalises a candidate-version number: returns a positive integer or `null`. */
function normalizeCandidateVersion(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const normalized = Math.trunc(value)
  return normalized > 0 ? normalized : null
}

/** Normalises a positive integer used in live progress labels. */
function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const normalized = Math.trunc(value)
  return normalized > 0 ? normalized : null
}

/** Returns `true` when `timestamp` is on or after `minimumTimestamp` (ISO-8601 strings). Falls back to `true` on parse errors. */
function isTimestampOnOrAfter(timestamp: string | undefined, minimumTimestamp: string | undefined): boolean {
  if (!minimumTimestamp) return true
  if (!timestamp) return false

  const timestampMs = Date.parse(timestamp)
  const minimumMs = Date.parse(minimumTimestamp)
  if (Number.isNaN(timestampMs) || Number.isNaN(minimumMs)) return true
  return timestampMs >= minimumMs
}

type ArtifactContentSource = Pick<DBartifact, 'content'>
type CoveragePassProgress = { run: number; max?: number }

/** Extracts a candidate version number from an artifact’s content or its companion payload. */
function extractArtifactCandidateVersion(
  artifact: ArtifactContentSource | undefined,
  expectedBaseArtifactType?: string,
): number | null {
  const companionVersion = normalizeCandidateVersion(
    parseArtifactCompanionPayload(artifact?.content, expectedBaseArtifactType)?.candidateVersion,
  )
  if (companionVersion) return companionVersion

  if (!artifact?.content?.trim()) return null
  try {
    const parsed = JSON.parse(artifact.content) as Record<string, unknown>
    return normalizeCandidateVersion(parsed.candidateVersion ?? parsed.finalCandidateVersion)
  } catch {
    return null
  }
}

/** Reads the highest candidate version from coverage, input, and revision artifacts for the current phase activation. */
function extractCoverageVersionFromArtifacts(phase: VersionedCoveragePhase, artifacts: DBartifact[]): number | null {
  const meta = COVERAGE_PHASE_META[phase]
  const coverageArtifact = findLatestArtifactByType(artifacts, meta.coverageArtifactType, [phase])
  const coverageCompanion = findLatestCompanionArtifact(artifacts, meta.coverageArtifactType, [phase])
  const mergedCoverageContent = buildCoverageArtifactContent(coverageArtifact?.content, coverageCompanion?.content)
  const parsedCoverageArtifact = mergedCoverageContent ? parseCoverageArtifact(mergedCoverageContent) : null
  const coverageVersion = parsedCoverageArtifact?.finalCandidateVersion
    ?? parsedCoverageArtifact?.attempts?.[parsedCoverageArtifact.attempts.length - 1]?.candidateVersion
    ?? null

  const coverageInputVersion = extractArtifactCandidateVersion(
    findLatestCompanionArtifact(artifacts, meta.coverageInputArtifactType, [phase])
      ?? findLatestArtifactByType(artifacts, meta.coverageInputArtifactType, [phase]),
    meta.coverageInputArtifactType,
  )

  const coverageRevisionVersion = extractArtifactCandidateVersion(
    findLatestCompanionArtifact(artifacts, meta.coverageRevisionArtifactType, [phase])
      ?? findLatestArtifactByType(artifacts, meta.coverageRevisionArtifactType, [phase]),
    meta.coverageRevisionArtifactType,
  )

  return [coverageVersion, coverageInputVersion, coverageRevisionVersion]
    .filter((version): version is number => typeof version === 'number')
    .reduce<number | null>((highest, version) => (highest == null || version > highest ? version : highest), null)
}

/** Scans log lines (newest-first) for candidate-version patterns (e.g., "PRD Candidate v3") and returns the latest version found. */
function extractCoverageVersionFromLogs(phase: VersionedCoveragePhase, lines: string[]): number | null {
  const candidateLabel = COVERAGE_PHASE_META[phase].candidateLabel
  const escapedCandidateLabel = candidateLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const revisingPattern = new RegExp(`Coverage found .* ${escapedCandidateLabel} v(\\d+)\\. Revising candidate before the next audit pass\\.`, 'i')
  const revisedPattern = new RegExp(`Revised ${escapedCandidateLabel} v\\d+ into ${escapedCandidateLabel} v(\\d+)\\.`, 'i')
  const genericVersionPattern = new RegExp(`${escapedCandidateLabel} v(\\d+)`, 'i')

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? ''
    const revisingMatch = line.match(revisingPattern)
    if (revisingMatch) {
      const currentVersion = Number.parseInt(revisingMatch[1] ?? '', 10)
      return Number.isFinite(currentVersion) ? currentVersion + 1 : null
    }

    const revisedMatch = line.match(revisedPattern)
    if (revisedMatch) {
      const nextVersion = Number.parseInt(revisedMatch[1] ?? '', 10)
      return Number.isFinite(nextVersion) ? nextVersion : null
    }

    const genericMatch = line.match(genericVersionPattern)
    if (genericMatch) {
      const version = Number.parseInt(genericMatch[1] ?? '', 10)
      return Number.isFinite(version) ? version : null
    }
  }

  return null
}

function parseArtifactRecord(content: string | null | undefined): Record<string, unknown> | null {
  if (!content?.trim()) return null
  try {
    const parsed = JSON.parse(content) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function extractCoveragePassFromRecord(record: Record<string, unknown> | null): CoveragePassProgress | null {
  if (!record) return null
  const attempts = Array.isArray(record.attempts) ? record.attempts : []
  const latestAttempt = attempts.length > 0
    ? attempts[attempts.length - 1]
    : null
  const latestAttemptRecord = latestAttempt && typeof latestAttempt === 'object' && !Array.isArray(latestAttempt)
    ? latestAttempt as Record<string, unknown>
    : null

  const run = normalizePositiveInteger(record.coverageRunNumber)
    ?? normalizePositiveInteger(latestAttemptRecord?.coverageRunNumber)
  if (!run) return null

  const max = normalizePositiveInteger(record.maxCoveragePasses)
    ?? normalizePositiveInteger(latestAttemptRecord?.maxCoveragePasses)
    ?? undefined
  return { run, ...(max ? { max } : {}) }
}

function extractCoveragePassFromArtifactContent(
  artifact: ArtifactContentSource | undefined,
  expectedBaseArtifactType?: string,
): CoveragePassProgress | null {
  if (!artifact?.content?.trim()) return null
  const companionRecord = parseArtifactCompanionPayload(artifact.content, expectedBaseArtifactType)
  return extractCoveragePassFromRecord(companionRecord ?? parseArtifactRecord(artifact.content))
}

function chooseLatestCoveragePassProgress(
  candidates: Array<CoveragePassProgress | null>,
): CoveragePassProgress | null {
  return candidates
    .filter((candidate): candidate is CoveragePassProgress => Boolean(candidate))
    .reduce<CoveragePassProgress | null>((latest, candidate) => (
      latest == null || candidate.run >= latest.run ? candidate : latest
    ), null)
}

function extractCoveragePassFromArtifacts(phase: CoveragePhase, artifacts: DBartifact[]): CoveragePassProgress | null {
  const meta = COVERAGE_ARTIFACT_TYPES[phase]
  const coverageArtifact = findLatestArtifactByType(artifacts, meta.coverageArtifactType, [phase])
  const coverageCompanion = findLatestCompanionArtifact(artifacts, meta.coverageArtifactType, [phase])
  const inputArtifact = findLatestArtifactByType(artifacts, meta.coverageInputArtifactType, [phase])
  const inputCompanion = findLatestCompanionArtifact(artifacts, meta.coverageInputArtifactType, [phase])
  const revisionArtifact = meta.coverageRevisionArtifactType
    ? findLatestArtifactByType(artifacts, meta.coverageRevisionArtifactType, [phase])
    : undefined
  const revisionCompanion = meta.coverageRevisionArtifactType
    ? findLatestCompanionArtifact(artifacts, meta.coverageRevisionArtifactType, [phase])
    : undefined

  return chooseLatestCoveragePassProgress([
    extractCoveragePassFromArtifactContent(coverageArtifact, meta.coverageArtifactType),
    extractCoveragePassFromArtifactContent(coverageCompanion, meta.coverageArtifactType),
    extractCoveragePassFromArtifactContent(inputArtifact, meta.coverageInputArtifactType),
    extractCoveragePassFromArtifactContent(inputCompanion, meta.coverageInputArtifactType),
    extractCoveragePassFromArtifactContent(revisionArtifact, meta.coverageRevisionArtifactType),
    extractCoveragePassFromArtifactContent(revisionCompanion, meta.coverageRevisionArtifactType),
  ])
}

function extractCoveragePassFromLogs(lines: string[]): CoveragePassProgress | null {
  const runPatterns = [
    /\b(?:run|pass)\s+(\d+)\s*(?:\/|of)\s*(\d+)\b/i,
    /\((\d+)\s*\/\s*(\d+)\)/,
  ]

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? ''
    for (const pattern of runPatterns) {
      const match = line.match(pattern)
      if (!match) continue
      const run = Number.parseInt(match[1] ?? '', 10)
      const max = Number.parseInt(match[2] ?? '', 10)
      if (Number.isFinite(run) && run > 0 && Number.isFinite(max) && max > 0) {
        return { run, max }
      }
    }
  }

  return null
}

/** Walks log entries backwards to find the timestamp when this phase was last activated (used to scope coverage-version queries to the current run). */
function findLatestPhaseActivationTimestamp(phase: string, logLines: Array<{ line: string; timestamp?: string }>): string | undefined {
  for (let index = logLines.length - 1; index >= 0; index -= 1) {
    const entry = logLines[index]
    if (!entry) continue
    if (entry.line.includes(`-> ${phase}`) || entry.line.includes(`Status ${phase} is active.`)) {
      return entry.timestamp
    }
  }
  return undefined
}

function DetailsList({ items }: { items: readonly string[] }) {
  return (
    <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}

function formatCodingLiveLabel(runtime: ReturnType<typeof getTicketRuntime>): string {
  const beadLabel = runtime.currentBead > 0 && runtime.totalBeads > 0
    ? `working on bead ${runtime.currentBead} of ${runtime.totalBeads}`
    : null
  const iterationLabel = runtime.activeBeadIteration && runtime.activeBeadIteration > 0
    ? `iteration ${runtime.activeBeadIteration}${runtime.maxIterationsPerBead && runtime.maxIterationsPerBead > 0 ? ` of ${runtime.maxIterationsPerBead}` : ''}`
    : null
  const details = [beadLabel, iterationLabel].filter((detail): detail is string => Boolean(detail))
  return details.length > 0 ? `Implementing (${details.join(', ')})` : 'Implementing'
}

function formatCoverageLiveLabel(
  baseLabel: string,
  candidateVersion: number | null,
  coveragePass: CoveragePassProgress | null,
): string {
  const details: string[] = []
  if (candidateVersion) details.push(`checking version ${candidateVersion}`)
  if (coveragePass) {
    details.push(`pass ${coveragePass.run}${coveragePass.max ? ` of ${coveragePass.max}` : ''}`)
  }
  return details.length > 0 ? `${baseLabel} (${details.join(', ')})` : baseLabel
}

function getSummaryBasePhaseLabel(phase: string, errorMessage?: string | null): string {
  if (phase === 'CODING') return 'Implementing'
  return getStatusUserLabel(phase, { errorMessage })
}

const MAX_SUMMARY_ERROR_LENGTH = 240

function normalizeSummaryError(errorMessage?: string | null): string {
  const normalized = sanitizeErrorForDisplay(errorMessage ?? '').split('\n', 1)[0]?.replace(/\s+/g, ' ').trim()
  if (!normalized) return 'No error details were captured.'
  if (normalized.length <= MAX_SUMMARY_ERROR_LENGTH) return normalized
  return `${normalized.slice(0, MAX_SUMMARY_ERROR_LENGTH - 1).trimEnd()}…`
}

function getBlockedErrorSummary(
  ticket: Ticket,
  occurrence?: TicketErrorOccurrence | null,
  errorMessage?: string | null,
): { label: string; description: string } {
  const blockedFromStatus = occurrence?.blockedFromStatus
    ?? (ticket.previousStatus && ticket.previousStatus !== 'BLOCKED_ERROR' ? ticket.previousStatus : null)
  const failedPhaseLabel = blockedFromStatus ? getStatusUserLabel(blockedFromStatus) : 'Workflow phase'
  const message = normalizeSummaryError(occurrence?.errorMessage || errorMessage || ticket.errorMessage)
  const isLiveOccurrence = ticket.status === 'BLOCKED_ERROR' && (!occurrence || occurrence.resolvedAt === null)

  if (!isLiveOccurrence) {
    return {
      label: `Past error — ${failedPhaseLabel}`,
      description: `${failedPhaseLabel} failed: ${message} This saved occurrence is read-only; its resolution is available in Details.`,
    }
  }

  const recoveryGuidance: string[] = []
  if (ticket.availableActions.includes('retry')) {
    recoveryGuidance.push(`Retry starts a fresh ${failedPhaseLabel} attempt`)
  }
  if (ticket.availableActions.includes('continue')) {
    recoveryGuidance.push('Continue resumes the preserved provider session')
  }
  if (recoveryGuidance.length === 0) {
    recoveryGuidance.push('Open Details to review the failure and available recovery options')
  }

  return {
    label: `Error — ${failedPhaseLabel}`,
    description: `${failedPhaseLabel} failed: ${message} ${recoveryGuidance.join('. ')}.`,
  }
}

function getActivePhaseAttempt(attempts: TicketPhaseAttempt[]): TicketPhaseAttempt | null {
  return attempts.find((attempt) => attempt.state === 'active') ?? attempts[0] ?? null
}

function getExecutionSetupAttemptInfo(logs: LogEntry[]): { attempt: number; maxIterations?: number; startedAt?: string } | null {
  let attempt: number | null = null
  let maxIterations: number | null = null

  for (let i = logs.length - 1; i >= 0; i--) {
    const entry = logs[i]
    if (!entry) continue
    const line = entry.line

    const matchStart = /Starting execution setup attempt (\d+)(?: of (\d+))?/i.exec(line)
    if (matchStart) {
      if (attempt === null && matchStart[1]) attempt = parseInt(matchStart[1], 10)
      if (maxIterations === null && matchStart[2]) maxIterations = parseInt(matchStart[2], 10)
      if (attempt !== null) {
        return { attempt, ...(maxIterations !== null ? { maxIterations } : {}), ...(entry.timestamp ? { startedAt: entry.timestamp } : {}) }
      }
    }

    const matchResume = /Resuming execution setup session for user-requested attempt (\d+)(?: \(configured automatic budget (\d+)\))?/i.exec(line)
    if (matchResume) {
      if (attempt === null && matchResume[1]) attempt = parseInt(matchResume[1], 10)
      if (maxIterations === null && matchResume[2]) maxIterations = parseInt(matchResume[2], 10)
      if (attempt !== null) {
        return { attempt, ...(maxIterations !== null ? { maxIterations } : {}), ...(entry.timestamp ? { startedAt: entry.timestamp } : {}) }
      }
    }

    const matchPersist = /Starting execution setup tooling persistence attempt (\d+).+?base budget (\d+)/i.exec(line)
    if (matchPersist) {
      if (attempt === null && matchPersist[1]) attempt = parseInt(matchPersist[1], 10)
      if (maxIterations === null && matchPersist[2]) maxIterations = parseInt(matchPersist[2], 10)
      if (attempt !== null) {
        return { attempt, ...(maxIterations !== null ? { maxIterations } : {}), ...(entry.timestamp ? { startedAt: entry.timestamp } : {}) }
      }
    }

    const matchSessionCreated = /Execution setup attempt (\d+) session created/i.exec(line)
    if (matchSessionCreated && matchSessionCreated[1]) {
      if (attempt === null) attempt = parseInt(matchSessionCreated[1], 10)
    }

    const matchComplete = /Execution setup attempt (\d+) (?:produced|failed)/i.exec(line)
    if (matchComplete && matchComplete[1]) {
      if (attempt === null) attempt = parseInt(matchComplete[1], 10)
    }

    if (attempt !== null && maxIterations !== null) {
      break
    }
  }

  if (attempt !== null) {
    return {
      attempt,
      ...(maxIterations !== null ? { maxIterations } : {}),
    }
  }

  return null
}

/**
 * Collapsible status bar with phase label, description, "(details)" dialog trigger,
 * and optional live coverage-version badge.
 */
export function WorkspacePhaseSummary({ phase, ticket, errorMessage, errorOccurrence }: WorkspacePhaseSummaryProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [isExpanded, setIsExpanded] = useState(true)
  const phaseMeta = getWorkflowPhaseMeta(phase)
  const runtime = getTicketRuntime(ticket)
  const descriptionId = useId()
  const logCtx = useLogs()
  const isLivePhase = ticket.status === phase
  const shouldTrackCoverageProgress = isLivePhase && isCoveragePhase(phase)
  const shouldTrackPhaseAttempt = isLivePhase && phase !== 'CODING' && !isCoveragePhase(phase)
  const { artifacts } = useTicketArtifacts(ticket.id, { skipFetch: !shouldTrackCoverageProgress })
  const { data: phaseAttempts = [] } = useTicketPhaseAttempts(
    shouldTrackPhaseAttempt ? ticket.id : undefined,
    shouldTrackPhaseAttempt ? phase : undefined,
  )
  const activeAttempt = useMemo(
    () => shouldTrackPhaseAttempt ? getActivePhaseAttempt(phaseAttempts) : null,
    [phaseAttempts, shouldTrackPhaseAttempt],
  )
  const shouldTrackLogs = shouldTrackCoverageProgress || (isLivePhase && phase === 'PREPARING_EXECUTION_ENV')
  const phaseLogs = useMemo(
    () => shouldTrackLogs && logCtx
      ? logCtx.getLogsForPhase(phase, activeAttempt ? { phaseAttempt: activeAttempt.attemptNumber } : undefined)
      : [],
    [shouldTrackLogs, logCtx, phase, activeAttempt],
  )
  const phaseActivationTimestamp = shouldTrackCoverageProgress
    ? findLatestPhaseActivationTimestamp(phase, phaseLogs)
    : undefined

  const blockedErrorSummary = useMemo(
    () => phase === 'BLOCKED_ERROR' ? getBlockedErrorSummary(ticket, errorOccurrence, errorMessage) : null,
    [errorMessage, errorOccurrence, phase, ticket],
  )
  const basePhaseLabel = useMemo(
    () => blockedErrorSummary?.label ?? getSummaryBasePhaseLabel(phase, errorMessage),
    [blockedErrorSummary, errorMessage, phase],
  )
  const summaryDescription = blockedErrorSummary?.description ?? phaseMeta?.description ?? ''
  const coverageVersion = useMemo(() => {
    if (!shouldTrackCoverageProgress || !isVersionedCoveragePhase(phase)) return null

    const runArtifacts = phaseActivationTimestamp
      ? artifacts.filter((artifact) => artifact.phase !== phase || isTimestampOnOrAfter(artifact.createdAt, phaseActivationTimestamp))
      : artifacts
    const runLogs = phaseActivationTimestamp
      ? phaseLogs.filter((entry) => isTimestampOnOrAfter(entry.timestamp, phaseActivationTimestamp))
      : phaseLogs
    const artifactVersion = extractCoverageVersionFromArtifacts(phase, runArtifacts)
    const logVersion = extractCoverageVersionFromLogs(phase, runLogs.map((entry) => entry.line))

    return Math.max(artifactVersion ?? 1, logVersion ?? 1)
  }, [artifacts, phase, phaseActivationTimestamp, phaseLogs, shouldTrackCoverageProgress])
  const coveragePass = useMemo(() => {
    if (!shouldTrackCoverageProgress || !isCoveragePhase(phase)) return null

    const runArtifacts = phaseActivationTimestamp
      ? artifacts.filter((artifact) => artifact.phase !== phase || isTimestampOnOrAfter(artifact.createdAt, phaseActivationTimestamp))
      : artifacts
    const runLogs = phaseActivationTimestamp
      ? phaseLogs.filter((entry) => isTimestampOnOrAfter(entry.timestamp, phaseActivationTimestamp))
      : phaseLogs
    return chooseLatestCoveragePassProgress([
      extractCoveragePassFromArtifacts(phase, runArtifacts),
      extractCoveragePassFromLogs(runLogs.map((entry) => entry.line)),
    ])
  }, [artifacts, phase, phaseActivationTimestamp, phaseLogs, shouldTrackCoverageProgress])
  const phaseAttemptLabel = useMemo(() => {
    if (!activeAttempt || activeAttempt.attemptNumber <= 1) return null
    const previousAttempt = phaseAttempts.find((attempt) => attempt.attemptNumber === activeAttempt.attemptNumber - 1)
    const isManualRetry = previousAttempt?.archivedReason === 'manual_retry_after_blocked_error'
    return `${isManualRetry ? 'retry attempt' : 'attempt'} ${activeAttempt.attemptNumber}`
  }, [activeAttempt, phaseAttempts])
  const phaseLabel = useMemo(() => {
    if (!isLivePhase) return basePhaseLabel
    if (phase === 'CODING') return formatCodingLiveLabel(runtime)
    if (isCoveragePhase(phase)) {
      return formatCoverageLiveLabel(basePhaseLabel, coverageVersion, coveragePass)
    }
    if (phase === 'PREPARING_EXECUTION_ENV') {
      const setupInfo = getExecutionSetupAttemptInfo(phaseLogs)
      if (setupInfo && setupInfo.attempt > 1) {
        const setupStr = setupInfo.maxIterations
          ? `execution setup attempt ${setupInfo.attempt} of ${setupInfo.maxIterations}`
          : `execution setup attempt ${setupInfo.attempt}`
        return phaseAttemptLabel
          ? `${basePhaseLabel} (${phaseAttemptLabel} - ${setupStr})`
          : `${basePhaseLabel} (${setupStr})`
      }
    }
    return phaseAttemptLabel ? `${basePhaseLabel} (${phaseAttemptLabel})` : basePhaseLabel
  }, [basePhaseLabel, coveragePass, coverageVersion, isLivePhase, phase, phaseAttemptLabel, runtime, phaseLogs])
  const showLiveCodingCountdown = ticket.status === 'CODING' && phase === 'CODING'
  const liveExecutionSetup = useMemo(
    () => ticket.status === 'PREPARING_EXECUTION_ENV' && phase === 'PREPARING_EXECUTION_ENV'
      ? getExecutionSetupAttemptInfo(phaseLogs)
      : null,
    [phase, phaseLogs, ticket.status],
  )

  if (!phaseMeta) return null

  return (
    <>
      <div className="shrink-0 border-b border-border bg-muted/20 px-4 py-1.5">
        <button
          type="button"
          onClick={() => setIsExpanded((value) => !value)}
          aria-expanded={isExpanded}
          aria-controls={descriptionId}
          aria-label={phaseLabel}
          className="flex items-center gap-1 py-0 text-[13px] font-medium text-foreground transition-colors hover:text-foreground/80"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', isExpanded && 'rotate-90')} />
          {phase === 'BLOCKED_ERROR' && (
            <AlertTriangle className="h-3.5 w-3.5 text-destructive animate-wobble-throb shrink-0" />
          )}
          <span>{phaseLabel}</span>
          {showLiveCodingCountdown && runtime.activeBeadId && runtime.perIterationTimeoutMs ? (() => {
            const activeBead = runtime.beads?.find(b => b.id === runtime.activeBeadId)
            if (activeBead?.status === 'in_progress' && activeBead.startedAt) {
              return (
                <ActiveBeadCountdown
                  startedAt={activeBead.updatedAt ?? activeBead.startedAt}
                  perIterationTimeoutMs={runtime.perIterationTimeoutMs}
                />
              )
            }
            return null
          })() : null}
          {liveExecutionSetup?.startedAt && runtime.executionSetupTimeoutMs ? (
            <ActiveBeadCountdown
              startedAt={liveExecutionSetup.startedAt}
              perIterationTimeoutMs={runtime.executionSetupTimeoutMs}
              tooltip="Time remaining for the current workspace runtime setup attempt before it times out and is retried."
            />
          ) : null}
        </button>
        {isExpanded ? (
          <p id={descriptionId} className="mt-px ml-5 text-[11px] leading-[15px] text-muted-foreground">
            {summaryDescription}
            {' '}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    setIsOpen(true)
                  }}
                  className="underline underline-offset-2 transition-colors hover:text-foreground"
                  aria-label={`Show detailed explanation for ${phaseLabel}`}
                >
                  (details)
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">See a full breakdown of what happens in this status.</TooltipContent>
            </Tooltip>
          </p>
        ) : null}
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent closeButtonVariant="dashboard" className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{phaseLabel}</DialogTitle>
            <DialogDescription>{summaryDescription}</DialogDescription>
          </DialogHeader>
          <div className="space-y-5 overflow-y-auto pr-2">
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">Overview</h3>
              <p className="text-sm leading-6 text-muted-foreground">{phaseMeta.details.overview}</p>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">Step by Step</h3>
              <DetailsList items={phaseMeta.details.steps} />
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">Outputs</h3>
              <DetailsList items={phaseMeta.details.outputs} />
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">Transitions</h3>
              <DetailsList items={phaseMeta.details.transitions} />
            </section>

            {phaseMeta.details.equivalents && phaseMeta.details.equivalents.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Equivalent Steps in Other Phases</h3>
                <DetailsList items={phaseMeta.details.equivalents} />
              </section>
            ) : null}

            {phaseMeta.details.notes && phaseMeta.details.notes.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Notes</h3>
                <DetailsList items={phaseMeta.details.notes} />
              </section>
            ) : null}

            {phaseMeta.contextSummary.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Context</h3>
                <p className="text-sm text-muted-foreground">Data and artifacts the AI receives in this phase:</p>
                {phaseMeta.contextSections && phaseMeta.contextSections.length > 0 ? (
                  <div className="space-y-3">
                    {phaseMeta.contextSections.map((section) => (
                      <div key={section.label} className="space-y-1">
                        <h4 className="text-sm font-medium text-foreground">
                          {section.label}
                          {section.description ? <span className="font-normal text-muted-foreground">{` — ${section.description}`}</span> : null}
                        </h4>
                        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                          {section.keys.map((key) => {
                            const info = CONTEXT_KEY_LABELS[key]
                            return (
                              <li key={key}>
                                <span className="font-medium text-foreground">{info.label}</span>
                                {` — ${info.description}`}
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : (
                  <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                    {phaseMeta.contextSummary.map((key) => {
                      const info = CONTEXT_KEY_LABELS[key]
                      return (
                        <li key={key}>
                          <span className="font-medium text-foreground">{info.label}</span>
                          {` — ${info.description}`}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            ) : null}

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">Workflow Info</h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Status ID</dt>
                <dd className="font-mono text-foreground">{phase}</dd>
                <dt className="text-muted-foreground">Phase Type</dt>
                <dd className="text-foreground">{phaseMeta.kanbanPhase === 'needs_input' ? 'User Input' : 'AI-Driven'}</dd>
                <dt className="text-muted-foreground">Kanban Phase</dt>
                <dd className="text-foreground">{KANBAN_PHASE_LABELS[phaseMeta.kanbanPhase] ?? phaseMeta.kanbanPhase}</dd>
                <dt className="text-muted-foreground">Group</dt>
                <dd className="text-foreground">{WORKFLOW_GROUPS.find((g) => g.id === phaseMeta.groupId)?.label ?? phaseMeta.groupId}</dd>
                <dt className="text-muted-foreground">UI View</dt>
                <dd className="text-foreground capitalize">{phaseMeta.uiView}</dd>
                <dt className="text-muted-foreground">Editable</dt>
                <dd className="text-foreground">{phaseMeta.editable ? 'Yes' : 'No'}</dd>
                <dt className="text-muted-foreground">Multi-Model</dt>
                <dd className="text-foreground">{phaseMeta.multiModelLogs ? 'Yes' : 'No'}</dd>
                {phaseMeta.progressKind ? (
                  <>
                    <dt className="text-muted-foreground">Progress Tracking</dt>
                    <dd className="text-foreground capitalize">{phaseMeta.progressKind}</dd>
                  </>
                ) : null}
                {phaseMeta.reviewArtifactType ? (
                  <>
                    <dt className="text-muted-foreground">Review Artifact</dt>
                    <dd className="text-foreground capitalize">{phaseMeta.reviewArtifactType.replace(/_/g, ' ')}</dd>
                  </>
                ) : null}
              </dl>
            </section>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
