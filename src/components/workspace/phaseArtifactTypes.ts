import * as jsYaml from 'js-yaml'
import type { StructuredIntervention } from '@shared/structuredInterventions'
import type { StructuredRetryDiagnostic } from '@shared/structuredRetryDiagnostics'
import type { CommandSpec } from '@shared/commandSpec'
import { normalizeStructuredRetryDiagnostics } from '@shared/structuredRetryDiagnostics'
import { normalizeStructuredInterventions } from '@shared/structuredInterventions'
import { isRecord } from '@shared/typeGuards'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import type { DBartifact } from '@/hooks/useTicketArtifacts'
import {
  mergeCoverageArtifactContent,
  mergeVoteArtifactContent,
  parseArtifactCompanionPayload,
  readWinnerIdFromArtifactContent,
} from './artifactCompanionUtils'
import {
  extractInterviewQuestionPreviews,
  type InterviewQuestionChange,
  type InterviewQuestionChangeAttributionStatus,
} from '@shared/interviewQuestions'
import type { RefinementChange, RefinementChangeAttributionStatus } from '@shared/refinementChanges'
import {
  buildBeadsUiRefinementDiffArtifact,
  buildInterviewUiRefinementDiffArtifact,
  buildPrdUiRefinementDiffArtifact,
  parseUiRefinementDiffArtifact,
} from '@shared/refinementDiffArtifacts'
import type { UiRefinementDiffArtifact } from '@shared/refinementDiffArtifacts'
import {
  buildTextDiffSegments,
  type TextDiffSegment,
} from './textDiffSegments'
export {
  TEXT_DIFF_TOKEN_PATTERN as QUESTION_DIFF_TOKEN_PATTERN,
  tokenizeTextDiff as tokenizeQuestionDiffText,
  mergeTextDiffSegments as mergeQuestionDiffSegments,
} from './textDiffSegments'

export interface ArtifactDef {
  id: string
  label: string
  description: string
  icon: React.ReactNode
}

export interface InterviewAnswerField {
  skipped?: boolean
  free_text?: string
  selected_option_ids?: string[]
}

export interface InterviewArtifactOption {
  id?: string
  label?: string
}

export interface InterviewArtifactQuestion {
  id?: string
  prompt?: string
  answer_type?: string
  options?: InterviewArtifactOption[]
  answer?: InterviewAnswerField
}

export interface InterviewArtifactData {
  artifact?: string
  questions?: InterviewArtifactQuestion[]
  interview?: string
  refinedContent?: string
  userAnswers?: string
}

export interface CoverageInputData {
  interview?: string
  fullAnswers?: string
  prd?: string
  beads?: string
  refinedContent?: string
  changes?: RefinementChange[]
  candidateVersion?: number
}

export interface CoverageGapResolutionItemData {
  itemType: 'epic' | 'user_story' | 'bead'
  id: string
  label: string
}

export interface CoverageGapResolutionData {
  gap: string
  action: 'updated_prd' | 'updated_beads' | 'already_covered' | 'left_unresolved'
  rationale: string
  affectedItems: CoverageGapResolutionItemData[]
}

export interface CoverageAttemptData {
  candidateVersion: number
  status: 'clean' | 'gaps'
  summary: string
  gaps: string[]
  auditNotes: string
  response?: string
  normalizedContent?: string
  structuredOutput?: ArtifactStructuredOutputData
  rawAttempts?: ArtifactRawAttemptData[]
  coverageRunNumber?: number
  maxCoveragePasses?: number
  limitReached?: boolean
  terminationReason?: string | null
  source?: string
  extraFixNumber?: number
}

export interface CoverageTransitionData {
  fromVersion: number
  toVersion: number
  summary: string
  gaps: string[]
  auditNotes: string
  fromContent: string
  toContent: string
  gapResolutions: CoverageGapResolutionData[]
  resolutionNotes: string[]
  uiRefinementDiff?: UiRefinementDiffArtifact | null
  structuredOutput?: ArtifactStructuredOutputData
  rawAttempts?: ArtifactRawAttemptData[]
  source?: string
  extraFixNumber?: number
  noChange?: boolean
  label?: string
}

export interface CoverageFollowUpArtifactQuestion {
  id?: string
  question?: string
  prompt?: string
  phase?: string
  priority?: string
  rationale?: string
}

export interface CoverageArtifactData {
  winnerId?: string
  response?: string
  hasGaps?: boolean
  normalizedContent?: string
  coverageRunNumber?: number
  maxCoveragePasses?: number
  limitReached?: boolean
  terminationReason?: string
  followUpBudgetPercent?: number
  followUpBudgetTotal?: number
  followUpBudgetUsed?: number
  followUpBudgetRemaining?: number
  status?: string
  summary?: string
  gaps?: string[]
  auditNotes?: string
  finalCandidateVersion?: number
  attempts?: CoverageAttemptData[]
  transitions?: CoverageTransitionData[]
  hasRemainingGaps?: boolean
  remainingGaps?: string[]
  latestExtraFixSummary?: string | null
  parsed?: {
    status?: string
    gaps?: string[]
    followUpQuestions?: CoverageFollowUpArtifactQuestion[]
    follow_up_questions?: CoverageFollowUpArtifactQuestion[]
  }
  structuredOutput?: ArtifactStructuredOutputData
  rawAttempts?: ArtifactRawAttemptData[]
}

export interface ArtifactStructuredOutputData {
  repairApplied?: boolean
  repairWarnings?: string[]
  autoRetryCount?: number
  validationError?: string
  retryDiagnostics?: StructuredRetryDiagnostic[]
  interventions?: StructuredIntervention[]
}

export interface ArtifactRawAttemptData {
  attempt?: number
  iteration?: number
  label?: string
  status?: string
  outcome?: string
  stage?: string
  initialInput?: string
  rawResponse?: string
  modelOutput?: string
  content?: string
  error?: string
  validationError?: string
  failureClass?: string
  modelId?: string
  sessionId?: string
}

export interface CouncilDraftData {
  memberId: string
  outcome?: CouncilOutcome
  content?: string
  duration?: number
  error?: string
  structuredOutput?: ArtifactStructuredOutputData
  rawResponse?: string
  normalizedResponse?: string
  rawAttempts?: ArtifactRawAttemptData[]
  skippedReason?: string
}

export interface CouncilVoteData {
  voterId: string
  draftId: string
  totalScore: number
  scores: Array<{ category: string; score: number }>
}

export interface VotePresentationOrderData {
  seed: string
  order: string[]
}

export interface CouncilVoterDetailData {
  voterId: string
  structuredOutput?: ArtifactStructuredOutputData
  error?: string
  rawResponse?: string
  normalizedResponse?: string
  rawAttempts?: ArtifactRawAttemptData[]
}

export interface CouncilResultData {
  drafts?: CouncilDraftData[]
  votes?: CouncilVoteData[]
  winnerId?: string
  winnerContent?: string
  refinedContent?: string
  voterOutcomes?: Record<string, CouncilOutcome>
  presentationOrders?: Record<string, VotePresentationOrderData>
  voterDetails?: CouncilVoterDetailData[]
}

export interface InterviewDiffArtifactData {
  winnerId?: string
  originalContent?: string
  refinedContent?: string
  originalQuestionCount?: number
  refinedQuestionCount?: number
  questionCount?: number
  questions?: unknown[]
  changes?: InterviewQuestionChange[]
  uiRefinementDiff?: UiRefinementDiffArtifact
  structuredOutput?: ArtifactStructuredOutputData
}

export interface InspirationDiffSource {
  memberId: string
  question: string
  questionId?: string
  phase?: string
}

export interface InterviewDiffEntry {
  key: string
  id: string
  changeType: 'modified' | 'replaced' | 'added' | 'removed'
  phase?: string
  before?: string
  after?: string
  inspiration?: InspirationDiffSource | null
  attributionStatus?: InterviewQuestionChangeAttributionStatus
}

export interface RefinementDiffArtifactData {
  winnerId?: string
  refinedContent?: string
  winnerDraftContent?: string
  semanticPlanContent?: string
  expandedContent?: string
  coverageBaselineContent?: string
  coverageBaselineVersion?: number
  coverageDiffLabel?: string
  changes?: RefinementChange[]
  uiRefinementDiff?: UiRefinementDiffArtifact
  coverageUiRefinementDiff?: UiRefinementDiffArtifact
  draftMetrics?: {
    epicCount: number
    userStoryCount: number
  }
  structuredOutput?: ArtifactStructuredOutputData
  candidateVersion?: number
  gapResolutions?: CoverageGapResolutionData[]
  rawAttempts?: ArtifactRawAttemptData[]
}

export interface RefinementDiffEntry {
  key: string
  changeType: 'modified' | 'added' | 'removed'
  itemKind: string
  label: string
  beforeId?: string
  afterId?: string
  beforeText?: string
  afterText?: string
  inspiration?: {
    memberId: string
    sourceId?: string
    sourceLabel: string
    sourceText?: string
    blocks?: Array<{
      kind: 'epic' | 'user_story' | 'bead'
      id?: string
      label: string
      text: string
    }>
  } | null
  attributionStatus?: RefinementChangeAttributionStatus
}

export type QuestionDiffSegment = TextDiffSegment

export interface RelevantFileScanEntry {
  path: string
  rationale: string
  relevance: string
  likely_action: string
  contentLength: number
  contentPreview: string
}

export interface RelevantFilesScanData {
  fileCount: number
  files: RelevantFileScanEntry[]
  modelId?: string
  structuredOutput?: ArtifactStructuredOutputData
  rawAttempts?: ArtifactRawAttemptData[]
}

export interface FinalTestCommandResultData {
  /** Structured command data is retained so the exact execution can be audited. */
  command: CommandSpec | string
  /** Human-readable command text emitted by the final-test runner. */
  displayCommand?: string
  effectiveCommand?: string
  setupWrapperApplied?: boolean
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

export interface FinalTestAttemptHistoryEntryData {
  attempt: number
  status: 'passed' | 'failed'
  checkedAt: string
  summary?: string
  commands: string[]
  testFiles: string[]
  modifiedFiles?: string[]
  fileEffects?: Array<{ path: string; intent: string; reason?: string }>
  errors: string[]
  failureReason?: string
  noteAppended?: string
}

export interface FinalTestExecutionReportData {
  status: 'passed' | 'failed'
  passed: boolean
  checkedAt: string
  plannedBy: string
  summary?: string
  testFiles?: string[]
  modifiedFiles?: string[]
  fileEffects?: Array<{ path: string; intent: string; reason?: string }>
  testsCount?: number | null
  modelOutput: string
  commands: FinalTestCommandResultData[]
  errors: string[]
  planStructuredOutput?: ArtifactStructuredOutputData
  rawAttempts?: ArtifactRawAttemptData[]
  attempt?: number
  maxIterations?: number | null
  attemptHistory?: FinalTestAttemptHistoryEntryData[]
  retryNotes?: string[]
}

export interface ExecutionSetupPlanReportData {
  status?: 'draft' | 'failed' | string
  ready?: boolean
  generatedAt?: string
  generatedBy?: string
  summary?: string
  modelOutput?: string
  rawAttempts?: ArtifactRawAttemptData[]
  errors: string[]
  structuredOutput?: ArtifactStructuredOutputData
  notes?: string[]
  source?: 'auto' | 'regenerate' | string
}

export interface ExecutionSetupReusableArtifactData {
  path: string
  kind: string
  purpose: string
}

export interface ExecutionSetupCommandProbeData {
  id: string
  command: string
  purpose: string
}

export interface ExecutionSetupCommandReceiptData {
  id: string
  command: string
  status: 'passed' | 'failed' | 'timed_out' | 'skipped'
  exitCode: number | null
  durationMs: number
  outputExcerpt: string
}

export interface ExecutionSetupGitHooksData {
  policy: 'observe_only' | 'validate_advisory' | 'validate_required' | 'use_native_hooks'
  detected: Array<{ name: string; path: string; source: string; kind: 'hook' | 'manager_config'; runnable: 'yes' | 'no' | 'unknown'; managerHint?: string }>
  validationCommands: Array<{ id: string; hook: string; command: string; purpose: string }>
  validationReceipts: ExecutionSetupCommandReceiptData[]
}

export interface ExecutionSetupProfileData {
  schemaVersion?: number
  ticketId?: string
  artifact?: string
  status?: string
  summary?: string
  tempRoots: string[]
  workspaceInputs: Array<{
    path: string
    kind: 'file' | 'directory'
    sourceStatus: 'ignored' | 'untracked'
    category: 'local_config' | 'secret' | 'fixture' | 'dataset' | 'other_non_reproducible'
    allowLargeCopy?: boolean
    reason: string
  }>
  bootstrapCommands: string[]
  toolingProbeCommands: string[]
  workspaceProbes: ExecutionSetupCommandProbeData[]
  workspaceProbeReceipts: ExecutionSetupCommandReceiptData[]
  gitHooks: ExecutionSetupGitHooksData
  reusableArtifacts: ExecutionSetupReusableArtifactData[]
  projectCommands: {
    prepare: string[]
    testFull: string[]
    lintFull: string[]
    typecheckFull: string[]
  }
  qualityGatePolicy: {
    tests: string
    lint: string
    typecheck: string
    fullProjectFallback: string
  }
  cautions: string[]
}

export interface ExecutionSetupAttemptHistoryEntryData {
  attempt: number
  status: string
  checkedAt?: string
  summary?: string
  tempRoots: string[]
  bootstrapCommands: string[]
  toolingProbeCommands: string[]
  errors: string[]
  failureReason?: string
  noteAppended?: string
}

export interface ExecutionSetupRuntimeReportData {
  status?: string
  ready?: boolean
  checkedAt?: string
  preparedBy?: string
  summary?: string
  profile: ExecutionSetupProfileData | null
  checks: {
    workspace: string
    tooling: string
    tempScope: string
    policy: string
  } | null
  modelOutput?: string
  rawAttempts?: ArtifactRawAttemptData[]
  errors: string[]
  worktreeWarnings: string[]
  structuredOutput?: ArtifactStructuredOutputData
  attempt?: number
  maxIterations?: number | null
  attemptHistory: ExecutionSetupAttemptHistoryEntryData[]
  retryNotes: string[]
  approvedPlanCommands: string[]
  executionAddedCommands: string[]
}

export interface IntegrationReportData {
  status?: string
  completedAt?: string
  baseBranch?: string
  preSquashHead?: string | null
  candidateCommitSha?: string | null
  mergeBase?: string | null
  commitCount?: number | null
  pushed?: boolean
  pushDeferred?: boolean
  pushError?: string | null
  message?: string
}

export interface PullRequestReportData {
  status?: string
  completedAt?: string
  baseBranch?: string
  headBranch?: string
  candidateCommitSha?: string | null
  prNumber?: number | null
  prUrl?: string | null
  prState?: 'draft' | 'open' | 'merged' | 'closed' | string | null
  prHeadSha?: string | null
  title?: string | null
  body?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  mergedAt?: string | null
  closedAt?: string | null
  message?: string
  candidateFileAudit?: PullRequestCandidateFileAuditData
}

export interface PullRequestCandidateFileAuditEntry {
  path: string
  decision: string
  reason?: string
}

export interface PullRequestCandidateFileAuditStats {
  totalFiles?: number
  includedFiles?: number
  excludedFiles?: number
  reviewedFiles?: number
}

export interface PullRequestCandidateFileAuditData {
  status?: string
  auditedAt?: string
  baseCommit?: string
  originalCandidateCommitSha?: string
  candidateCommitSha?: string | null
  includedFiles: string[]
  excludedFiles: string[]
  ignoredFiles: string[]
  reviewedFiles: string[]
  entries: PullRequestCandidateFileAuditEntry[]
  stats?: PullRequestCandidateFileAuditStats
  message?: string
  warnings: string[]
}

export interface CleanupReportData {
  status: 'clean' | 'warning'
  removedDirs: string[]
  removedFiles: string[]
  preservedPaths: string[]
  errors: string[]
}

import type { CouncilOutcome, CouncilViewerArtifact } from './councilArtifacts'

export type ViewingArtifact = CouncilViewerArtifact & {
  icon?: React.ReactNode
  reportContent?: string | null
}
export type ViewingArtifactSelection =
  | { kind: 'member'; key: string }
  | { kind: 'supplemental'; id: string }

// Re-export CouncilOutcome for convenience
export type { CouncilOutcome }

type InterviewDiffAttributionStatus = NonNullable<InterviewQuestionChange['attributionStatus']>
type RefinementDiffAttributionStatus = NonNullable<RefinementChange['attributionStatus']>

export function extractDraftDetail(content: string | null): string {
  if (!content) return ''
  const beadCount = countBeadsInContent(content)
  if (beadCount > 0) return `${beadCount} beads`
  const questionMatch = content.match(/(\d+)\s*(?:questions|Q)/i)
  if (questionMatch) return `proposed ${questionMatch[1]} questions`
  const scoreMatch = content.match(/(\d+\.?\d*)\s*\/\s*10/i)
  if (scoreMatch) return `scored ${scoreMatch[1]}/10`
  const lineCount = content.split('\n').filter(l => l.trim()).length
  if (lineCount > 0) return `${lineCount} lines`
  return ''
}

export function extractCompiledInterviewDetail(content: string | null): string {
  if (!content) return ''
  try {
    const parsed = JSON.parse(content) as {
      winnerId?: string
      questionCount?: number
      questions?: unknown[]
    }
    const count = typeof parsed.questionCount === 'number'
      ? parsed.questionCount
      : Array.isArray(parsed.questions)
        ? parsed.questions.length
        : 0
    const detailParts: string[] = []
    if (parsed.winnerId) detailParts.push(getModelDisplayName(parsed.winnerId))
    if (count > 0) detailParts.push(`${count} question${count === 1 ? '' : 's'}`)
    return detailParts.join(' · ')
  } catch {
    return ''
  }
}

export function tryParseStructuredContent(content: string | null | undefined): unknown {
  if (!content?.trim()) return null

  try {
    return JSON.parse(content)
  } catch {
    try {
      return jsYaml.load(content)
    } catch {
      return null
    }
  }
}

function countBeadsInContent(content: string): number {
  const parsed = tryParseStructuredContent(content)
  if (Array.isArray(parsed)) return parsed.length
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray((parsed as { beads?: unknown[] }).beads)) {
    return (parsed as { beads: unknown[] }).beads.length
  }
  if (parsed !== null) return 0

  const trimmed = content.trim()
  if (trimmed.startsWith('{')) {
    try {
      return trimmed
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown)
        .length
    } catch {
      // Ignore malformed JSONL and fall back to line-based counting.
    }
  }

  return (content.match(/^\s*-\s+id\s*:/gm) ?? []).length
}

export function extractCanonicalInterviewDetail(content: string | null): string {
  const parsed = tryParseStructuredContent(content)
  if (!parsed || typeof parsed !== 'object') return ''

  const artifact = parsed as InterviewArtifactData
  if (typeof artifact.interview === 'string' && artifact.interview.trim()) {
    return extractCanonicalInterviewDetail(artifact.interview)
  }

  if (artifact.artifact !== 'interview' || !Array.isArray(artifact.questions)) {
    return ''
  }

  const count = artifact.questions.length
  return count > 0 ? `${count} question${count === 1 ? '' : 's'}` : ''
}

export function normalizeInterviewDiffQuestions(content: string | undefined): Array<{ id: string; phase?: string; question: string }> {
  return extractInterviewQuestionPreviews(content ?? '')
    .map((question, index) => ({
      id: question.id || `Q${String(index + 1).padStart(2, '0')}`,
      phase: question.phase,
      question: question.question,
    }))
}

export function normalizeInterviewDiffQuestionRecord(value: unknown, fallbackIndex: number): { id: string; phase?: string; question: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' && record.id.trim()
    ? record.id.trim()
    : `Q${String(fallbackIndex + 1).padStart(2, '0')}`
  const phase = typeof record.phase === 'string' && record.phase.trim()
    ? record.phase.trim()
    : undefined
  const question = typeof record.question === 'string' ? record.question.trim() : ''

  if (!question) return null

  return { id, phase, question }
}

function normalizeInterviewDiffAttributionStatus(value: unknown): InterviewDiffAttributionStatus | undefined {
  if (
    value === 'inspired'
    || value === 'model_unattributed'
    || value === 'synthesized_unattributed'
    || value === 'invalid_unattributed'
  ) {
    return value
  }
  return undefined
}

function normalizeRefinementDiffAttributionStatus(value: unknown): RefinementDiffAttributionStatus | undefined {
  if (
    value === 'inspired'
    || value === 'model_unattributed'
    || value === 'synthesized_unattributed'
    || value === 'invalid_unattributed'
  ) {
    return value
  }
  return undefined
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

export function normalizeRawAttempts(value: unknown): ArtifactRawAttemptData[] | undefined {
  if (!Array.isArray(value)) return undefined
  const attempts = value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) => ({
      attempt: normalizeNumber(getValueByAliases(entry, ['attempt', 'attemptNumber', 'attempt_number'])),
      iteration: normalizeNumber(getValueByAliases(entry, ['iteration', 'beadIteration', 'bead_iteration'])),
      label: normalizeOptionalString(getValueByAliases(entry, ['label', 'name'])),
      status: normalizeOptionalString(getValueByAliases(entry, ['status', 'outcome'])),
      outcome: normalizeOptionalString(getValueByAliases(entry, ['outcome', 'status'])),
      stage: normalizeOptionalString(getValueByAliases(entry, ['stage', 'step'])),
      initialInput: normalizeOptionalString(getValueByAliases(entry, ['initialInput', 'initial_input'])),
      rawResponse: normalizeOptionalString(getValueByAliases(entry, ['rawResponse', 'raw_response'])),
      modelOutput: normalizeOptionalString(getValueByAliases(entry, ['modelOutput', 'model_output'])),
      content: normalizeOptionalString(getValueByAliases(entry, ['content', 'output'])),
      error: normalizeOptionalString(getValueByAliases(entry, ['error', 'message'])),
      validationError: normalizeOptionalString(getValueByAliases(entry, ['validationError', 'validation_error'])),
      failureClass: normalizeOptionalString(getValueByAliases(entry, ['failureClass', 'failure_class'])),
      modelId: normalizeOptionalString(getValueByAliases(entry, ['modelId', 'model_id', 'model'])),
      sessionId: normalizeOptionalString(getValueByAliases(entry, ['sessionId', 'session_id'])),
    }))
    .filter((entry) => entry.initialInput || entry.rawResponse || entry.modelOutput || entry.content || entry.error || entry.validationError)

  return attempts.length > 0 ? attempts : undefined
}

export function parseIntegrationReport(content: string): IntegrationReportData | null {
  const parsed = tryParseStructuredContent(content)
  if (!isRecord(parsed)) return null

  if (
    !('status' in parsed)
    && !('completedAt' in parsed)
    && !('baseBranch' in parsed)
    && !('candidateCommitSha' in parsed)
    && !('mergeBase' in parsed)
    && !('preSquashHead' in parsed)
    && !('commitCount' in parsed)
    && !('pushDeferred' in parsed)
    && !('pushError' in parsed)
    && !('message' in parsed)
  ) {
    return null
  }

  const normalizeNullableString = (value: unknown): string | null | undefined => {
    if (value === null) return null
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }

  const normalizeOptionalString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed ? trimmed : undefined
  }

  const commitCount = typeof parsed.commitCount === 'number' && Number.isFinite(parsed.commitCount)
    ? parsed.commitCount
    : parsed.commitCount === null
      ? null
      : undefined

  return {
    status: normalizeOptionalString(parsed.status),
    completedAt: normalizeOptionalString(parsed.completedAt),
    baseBranch: normalizeOptionalString(parsed.baseBranch),
    preSquashHead: normalizeNullableString(parsed.preSquashHead),
    candidateCommitSha: normalizeNullableString(parsed.candidateCommitSha),
    mergeBase: normalizeNullableString(parsed.mergeBase),
    commitCount,
    pushed: typeof parsed.pushed === 'boolean' ? parsed.pushed : undefined,
    pushDeferred: typeof parsed.pushDeferred === 'boolean' ? parsed.pushDeferred : undefined,
    pushError: normalizeNullableString(parsed.pushError),
    message: normalizeOptionalString(parsed.message),
  }
}

function normalizeNullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function normalizeCandidateAuditPath(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : undefined
  }
  if (!isRecord(value)) return undefined
  return normalizeOptionalString(getValueByAliases(value, ['path', 'file', 'filePath', 'file_path']))
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function normalizeCandidateAuditPathList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return uniqueStrings(value.map(normalizeCandidateAuditPath).filter((path): path is string => Boolean(path)))
}

function readCandidateAuditReason(reasonMaps: unknown[], path: string): string | undefined {
  for (const map of reasonMaps) {
    if (!isRecord(map)) continue
    const reason = normalizeOptionalString(map[path])
    if (reason) return reason
  }
  return undefined
}

function normalizeCandidateAuditEntries(
  value: unknown,
  fallbackDecision: string,
  reasonMaps: unknown[] = [],
): PullRequestCandidateFileAuditEntry[] {
  if (!Array.isArray(value)) return []

  return value
    .map((entry): PullRequestCandidateFileAuditEntry | null => {
      const path = normalizeCandidateAuditPath(entry)
      if (!path) return null

      if (!isRecord(entry)) {
        const reason = readCandidateAuditReason(reasonMaps, path)
        return {
          path,
          decision: fallbackDecision,
          ...(reason ? { reason } : {}),
        }
      }

      const decision = normalizeOptionalString(getValueByAliases(entry, ['decision', 'intent', 'classification', 'status']))
        ?? fallbackDecision
      const reason = normalizeOptionalString(getValueByAliases(entry, ['reason', 'rationale', 'explanation', 'message']))
        ?? readCandidateAuditReason(reasonMaps, path)

      return {
        path,
        decision,
        ...(reason ? { reason } : {}),
      }
    })
    .filter((entry): entry is PullRequestCandidateFileAuditEntry => entry !== null)
}

function normalizeCandidateAuditStats(value: unknown): PullRequestCandidateFileAuditStats | undefined {
  if (!isRecord(value)) return undefined
  const stats: PullRequestCandidateFileAuditStats = {}
  const totalFiles = normalizeNumber(getValueByAliases(value, ['totalFiles', 'total_files']))
  const includedFiles = normalizeNumber(getValueByAliases(value, ['includedFiles', 'included_files']))
  const excludedFiles = normalizeNumber(getValueByAliases(value, ['excludedFiles', 'excluded_files']))
  const reviewedFiles = normalizeNumber(getValueByAliases(value, ['reviewedFiles', 'reviewed_files']))

  if (totalFiles != null) stats.totalFiles = totalFiles
  if (includedFiles != null) stats.includedFiles = includedFiles
  if (excludedFiles != null) stats.excludedFiles = excludedFiles
  if (reviewedFiles != null) stats.reviewedFiles = reviewedFiles

  return Object.keys(stats).length > 0 ? stats : undefined
}

function isIncludedCandidateAuditDecision(decision: string): boolean {
  const normalized = decision.toLowerCase()
  return normalized === 'include' || normalized === 'included'
}

function isExcludedCandidateAuditDecision(decision: string): boolean {
  const normalized = decision.toLowerCase()
  return normalized === 'exclude' || normalized === 'excluded' || normalized === 'ignore' || normalized === 'ignored'
}

function isReviewedCandidateAuditDecision(decision: string): boolean {
  const normalized = decision.toLowerCase()
  return normalized === 'review' || normalized === 'reviewed'
}

function normalizeCandidateFileAudit(value: unknown): PullRequestCandidateFileAuditData | undefined {
  if (!isRecord(value)) return undefined

  const ignoredReasonMaps = [
    getValueByAliases(value, ['ignoredReasons', 'ignored_reasons']),
    getValueByAliases(value, ['excludedReasons', 'excluded_reasons']),
  ]
  const includedEntries = normalizeCandidateAuditEntries(
    getValueByAliases(value, ['includedFiles', 'included_files', 'candidateFiles', 'candidate_files']),
    'include',
  )
  const excludedEntries = normalizeCandidateAuditEntries(
    getValueByAliases(value, ['excludedFiles', 'excluded_files', 'excludedCandidateFiles', 'excluded_candidate_files']),
    'exclude',
    ignoredReasonMaps,
  )
  const ignoredEntries = normalizeCandidateAuditEntries(
    getValueByAliases(value, ['ignoredFiles', 'ignored_files', 'ignoredCandidateFiles', 'ignored_candidate_files']),
    'ignored',
    ignoredReasonMaps,
  )
  const reviewedEntries = normalizeCandidateAuditEntries(
    getValueByAliases(value, ['reviewedFiles', 'reviewed_files']),
    'review',
  )
  const recordedEntries = normalizeCandidateAuditEntries(value.entries, 'review', ignoredReasonMaps)
  const entries = [...recordedEntries]
  const seenEntries = new Set(entries.map((entry) => `${entry.decision.toLowerCase()}:${entry.path}`))

  for (const entry of [...includedEntries, ...excludedEntries, ...ignoredEntries, ...reviewedEntries]) {
    const key = `${entry.decision.toLowerCase()}:${entry.path}`
    if (seenEntries.has(key)) continue
    seenEntries.add(key)
    entries.push(entry)
  }

  const includedFiles = uniqueStrings([
    ...normalizeCandidateAuditPathList(getValueByAliases(value, ['includedFiles', 'included_files', 'candidateFiles', 'candidate_files'])),
    ...entries.filter((entry) => isIncludedCandidateAuditDecision(entry.decision)).map((entry) => entry.path),
  ])
  const ignoredFiles = uniqueStrings([
    ...normalizeCandidateAuditPathList(getValueByAliases(value, ['ignoredFiles', 'ignored_files', 'ignoredCandidateFiles', 'ignored_candidate_files'])),
    ...entries.filter((entry) => {
      const normalized = entry.decision.toLowerCase()
      return normalized === 'ignore' || normalized === 'ignored'
    }).map((entry) => entry.path),
  ])
  const excludedFiles = uniqueStrings([
    ...normalizeCandidateAuditPathList(getValueByAliases(value, ['excludedFiles', 'excluded_files', 'excludedCandidateFiles', 'excluded_candidate_files'])),
    ...ignoredFiles,
    ...entries.filter((entry) => isExcludedCandidateAuditDecision(entry.decision)).map((entry) => entry.path),
  ])
  const reviewedFiles = uniqueStrings([
    ...normalizeCandidateAuditPathList(getValueByAliases(value, ['reviewedFiles', 'reviewed_files'])),
    ...entries.filter((entry) => isReviewedCandidateAuditDecision(entry.decision)).map((entry) => entry.path),
  ])
  const stats = normalizeCandidateAuditStats(value.stats)
  const candidateCommitSha = normalizeNullableString(getValueByAliases(value, ['candidateCommitSha', 'candidate_commit_sha']))

  return {
    status: normalizeOptionalString(value.status),
    auditedAt: normalizeOptionalString(getValueByAliases(value, ['auditedAt', 'audited_at', 'capturedAt', 'captured_at'])),
    baseCommit: normalizeOptionalString(getValueByAliases(value, ['baseCommit', 'base_commit'])),
    originalCandidateCommitSha: normalizeOptionalString(getValueByAliases(value, ['originalCandidateCommitSha', 'original_candidate_commit_sha'])),
    ...(candidateCommitSha !== undefined ? { candidateCommitSha } : {}),
    includedFiles,
    excludedFiles,
    ignoredFiles,
    reviewedFiles,
    entries,
    ...(stats ? { stats } : {}),
    message: normalizeOptionalString(value.message),
    warnings: normalizeStringArray(value.warnings),
  }
}

export function parsePullRequestReport(content: string): PullRequestReportData | null {
  const parsed = tryParseStructuredContent(content)
  if (!isRecord(parsed)) return null

  if (
    !('status' in parsed)
    && !('completedAt' in parsed)
    && !('baseBranch' in parsed)
    && !('headBranch' in parsed)
    && !('candidateCommitSha' in parsed)
    && !('prNumber' in parsed)
    && !('prUrl' in parsed)
    && !('prState' in parsed)
    && !('prHeadSha' in parsed)
    && !('title' in parsed)
    && !('body' in parsed)
    && !('message' in parsed)
    && !('candidateFileAudit' in parsed)
  ) {
    return null
  }

  const prNumber = typeof parsed.prNumber === 'number' && Number.isFinite(parsed.prNumber)
    ? parsed.prNumber
    : parsed.prNumber === null
      ? null
      : undefined

  return {
    status: normalizeOptionalString(parsed.status),
    completedAt: normalizeOptionalString(parsed.completedAt),
    baseBranch: normalizeOptionalString(parsed.baseBranch),
    headBranch: normalizeOptionalString(parsed.headBranch),
    candidateCommitSha: normalizeNullableString(parsed.candidateCommitSha),
    prNumber,
    prUrl: normalizeNullableString(parsed.prUrl),
    prState: normalizeNullableString(parsed.prState),
    prHeadSha: normalizeNullableString(parsed.prHeadSha),
    title: normalizeNullableString(parsed.title),
    body: normalizeNullableString(parsed.body),
    createdAt: normalizeNullableString(parsed.createdAt),
    updatedAt: normalizeNullableString(parsed.updatedAt),
    mergedAt: normalizeNullableString(parsed.mergedAt),
    closedAt: normalizeNullableString(parsed.closedAt),
    message: normalizeOptionalString(parsed.message),
    candidateFileAudit: normalizeCandidateFileAudit(parsed.candidateFileAudit),
  }
}

export function parseCleanupReport(content: string): CleanupReportData | null {
  const parsed = tryParseStructuredContent(content)
  if (!isRecord(parsed)) return null

  if (
    !('removedDirs' in parsed)
    && !('removedFiles' in parsed)
    && !('preservedPaths' in parsed)
    && !('errors' in parsed)
  ) {
    return null
  }

  const errors = normalizeStringArray(parsed.errors)
  const parsedStatus = parsed.status === 'warning' || parsed.status === 'clean'
    ? parsed.status
    : null
  return {
    status: parsedStatus ?? (errors.length > 0 ? 'warning' : 'clean'),
    removedDirs: normalizeStringArray(parsed.removedDirs),
    removedFiles: normalizeStringArray(parsed.removedFiles),
    preservedPaths: normalizeStringArray(parsed.preservedPaths),
    errors,
  }
}

export function parseExecutionSetupPlanReport(content: string): ExecutionSetupPlanReportData | null {
  const parsed = tryParseStructuredContent(content)
  if (!isRecord(parsed)) return null

  if (
    !('status' in parsed)
    && !('ready' in parsed)
    && !('generatedAt' in parsed)
    && !('generatedBy' in parsed)
    && !('summary' in parsed)
    && !('modelOutput' in parsed)
    && !('rawAttempts' in parsed)
    && !('raw_attempts' in parsed)
    && !('errors' in parsed)
    && !('structuredOutput' in parsed)
    && !('notes' in parsed)
    && !('source' in parsed)
  ) {
    return null
  }

  return {
    status: normalizeOptionalString(parsed.status),
    ready: typeof parsed.ready === 'boolean' ? parsed.ready : undefined,
    generatedAt: normalizeOptionalString(parsed.generatedAt),
    generatedBy: normalizeOptionalString(parsed.generatedBy),
    summary: normalizeOptionalString(parsed.summary),
    modelOutput: normalizeOptionalString(parsed.modelOutput),
    rawAttempts: normalizeRawAttempts(getValueByAliases(parsed, ['rawAttempts', 'raw_attempts'])),
    errors: normalizeStringArray(parsed.errors),
    structuredOutput: normalizeArtifactStructuredOutput(parsed.structuredOutput),
    notes: normalizeStringArray(parsed.notes),
    source: normalizeOptionalString(parsed.source),
  }
}

function getValueByAliases(record: Record<string, unknown>, aliases: string[]): unknown {
  for (const alias of aliases) {
    if (alias in record) return record[alias]
  }
  return undefined
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

function parseExecutionSetupProfileRecord(record: Record<string, unknown>): ExecutionSetupProfileData | null {
  const artifact = normalizeOptionalString(getValueByAliases(record, ['artifact']))
  const tempRoots = normalizeStringArray(getValueByAliases(record, ['tempRoots', 'temp_roots']))
  const bootstrapCommands = normalizeStringArray(getValueByAliases(record, ['bootstrapCommands', 'bootstrap_commands']))
  const toolingProbeCommands = normalizeStringArray(getValueByAliases(record, [
    'toolingProbeCommands',
    'tooling_probe_commands',
    'toolingProbes',
    'tooling_probes',
    'probeCommands',
    'probe_commands',
    'verificationCommands',
    'verification_commands',
  ]))
  const reusableArtifactsRaw = getValueByAliases(record, ['reusableArtifacts', 'reusable_artifacts'])
  const workspaceInputsRaw = getValueByAliases(record, ['workspaceInputs', 'workspace_inputs'])
  const projectCommandsRaw = getValueByAliases(record, ['projectCommands', 'project_commands'])
  const qualityGatePolicyRaw = getValueByAliases(record, ['qualityGatePolicy', 'quality_gate_policy'])
  const workspaceProbesRaw = getValueByAliases(record, ['workspaceProbes', 'workspace_probes'])
  const gitHooksRaw = getValueByAliases(record, ['gitHooks', 'git_hooks'])
  const workspaceProbeReceiptsRaw = getValueByAliases(record, ['workspaceProbeReceipts', 'workspace_probe_receipts'])

  if (
    artifact !== 'execution_setup_profile'
    && tempRoots.length === 0
    && bootstrapCommands.length === 0
    && toolingProbeCommands.length === 0
    && !Array.isArray(workspaceProbesRaw)
    && !isRecord(gitHooksRaw)
    && !isRecord(projectCommandsRaw)
    && !isRecord(qualityGatePolicyRaw)
  ) {
    return null
  }

  const projectCommands = isRecord(projectCommandsRaw) ? projectCommandsRaw : {}
  const qualityGatePolicy = isRecord(qualityGatePolicyRaw) ? qualityGatePolicyRaw : {}
  const gitHooks = isRecord(gitHooksRaw) ? gitHooksRaw : {}

  const workspaceProbes = Array.isArray(workspaceProbesRaw)
    ? workspaceProbesRaw.filter((entry): entry is Record<string, unknown> => isRecord(entry)).map((entry) => ({
        id: normalizeOptionalString(getValueByAliases(entry, ['id'])) ?? '',
        command: normalizeOptionalString(getValueByAliases(entry, ['command'])) ?? '',
        purpose: normalizeOptionalString(getValueByAliases(entry, ['purpose'])) ?? '',
      }))
    : []
  const detectedRaw = getValueByAliases(gitHooks, ['detected'])
  const validationCommandsRaw = getValueByAliases(gitHooks, ['validationCommands', 'validation_commands'])
  const validationReceiptsRaw = getValueByAliases(gitHooks, ['validationReceipts', 'validation_receipts'])
  const parseReceipts = (value: unknown): ExecutionSetupCommandReceiptData[] => Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => isRecord(entry)).map((entry) => {
        const rawStatus = getValueByAliases(entry, ['status'])
        const status: ExecutionSetupCommandReceiptData['status'] = rawStatus === 'failed' || rawStatus === 'timed_out' || rawStatus === 'skipped' ? rawStatus : 'passed'
        const exitCodeRaw = getValueByAliases(entry, ['exitCode', 'exit_code'])
        return {
          id: normalizeOptionalString(getValueByAliases(entry, ['id'])) ?? '',
          command: normalizeOptionalString(getValueByAliases(entry, ['command'])) ?? '',
          status,
          exitCode: typeof exitCodeRaw === 'number' && Number.isFinite(exitCodeRaw) ? exitCodeRaw : null,
          durationMs: normalizeNumber(getValueByAliases(entry, ['durationMs', 'duration_ms'])) ?? 0,
          outputExcerpt: normalizeOptionalString(getValueByAliases(entry, ['outputExcerpt', 'output_excerpt'])) ?? '',
        }
      })
    : []

  const reusableArtifacts = Array.isArray(reusableArtifactsRaw)
    ? reusableArtifactsRaw
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .map((entry) => ({
          path: normalizeOptionalString(getValueByAliases(entry, ['path'])) ?? '',
          kind: normalizeOptionalString(getValueByAliases(entry, ['kind', 'type'])) ?? '',
          purpose: normalizeOptionalString(getValueByAliases(entry, ['purpose', 'reason', 'summary'])) ?? '',
        }))
        .filter((entry) => entry.path || entry.kind || entry.purpose)
    : []

  return {
    schemaVersion: normalizeNumber(getValueByAliases(record, ['schemaVersion', 'schema_version'])),
    ticketId: normalizeOptionalString(getValueByAliases(record, ['ticketId', 'ticket_id'])),
    artifact,
    status: normalizeOptionalString(getValueByAliases(record, ['status'])),
    summary: normalizeOptionalString(getValueByAliases(record, ['summary'])),
    tempRoots,
    workspaceInputs: Array.isArray(workspaceInputsRaw)
      ? workspaceInputsRaw.filter((entry): entry is Record<string, unknown> => isRecord(entry)).map((entry) => ({
          path: normalizeOptionalString(getValueByAliases(entry, ['path'])) ?? '',
          kind: getValueByAliases(entry, ['kind']) === 'directory' ? 'directory' : 'file',
          sourceStatus: getValueByAliases(entry, ['sourceStatus', 'source_status']) === 'untracked' ? 'untracked' : 'ignored',
          category: ['local_config', 'secret', 'fixture', 'dataset', 'other_non_reproducible'].includes(String(getValueByAliases(entry, ['category'])))
            ? getValueByAliases(entry, ['category']) as ExecutionSetupProfileData['workspaceInputs'][number]['category']
            : 'other_non_reproducible',
          ...(getValueByAliases(entry, ['allowLargeCopy', 'allow_large_copy']) === true ? { allowLargeCopy: true } : {}),
          reason: normalizeOptionalString(getValueByAliases(entry, ['reason'])) ?? '',
        }))
      : [],
    bootstrapCommands,
    toolingProbeCommands,
    workspaceProbes,
    workspaceProbeReceipts: parseReceipts(workspaceProbeReceiptsRaw),
    gitHooks: {
      policy: ['observe_only', 'validate_advisory', 'validate_required', 'use_native_hooks'].includes(String(getValueByAliases(gitHooks, ['policy'])))
        ? getValueByAliases(gitHooks, ['policy']) as ExecutionSetupGitHooksData['policy']
        : 'validate_advisory',
      detected: Array.isArray(detectedRaw)
        ? detectedRaw.filter((entry): entry is Record<string, unknown> => isRecord(entry)).map((entry) => ({
            name: normalizeOptionalString(getValueByAliases(entry, ['name'])) ?? '',
            path: normalizeOptionalString(getValueByAliases(entry, ['path'])) ?? '',
            source: normalizeOptionalString(getValueByAliases(entry, ['source'])) ?? '',
            kind: getValueByAliases(entry, ['kind']) === 'manager_config' ? 'manager_config' : 'hook',
            runnable: getValueByAliases(entry, ['runnable']) === 'yes' || getValueByAliases(entry, ['runnable']) === 'no'
              ? getValueByAliases(entry, ['runnable']) as 'yes' | 'no'
              : 'unknown',
            ...(normalizeOptionalString(getValueByAliases(entry, ['managerHint', 'manager_hint']))
              ? { managerHint: normalizeOptionalString(getValueByAliases(entry, ['managerHint', 'manager_hint']))! }
              : {}),
          }))
        : [],
      validationCommands: Array.isArray(validationCommandsRaw)
        ? validationCommandsRaw.filter((entry): entry is Record<string, unknown> => isRecord(entry)).map((entry) => ({
            id: normalizeOptionalString(getValueByAliases(entry, ['id'])) ?? '',
            hook: normalizeOptionalString(getValueByAliases(entry, ['hook'])) ?? '',
            command: normalizeOptionalString(getValueByAliases(entry, ['command'])) ?? '',
            purpose: normalizeOptionalString(getValueByAliases(entry, ['purpose'])) ?? '',
          }))
        : [],
      validationReceipts: parseReceipts(validationReceiptsRaw),
    },
    reusableArtifacts,
    projectCommands: {
      prepare: normalizeStringArray(getValueByAliases(projectCommands, ['prepare'])),
      testFull: normalizeStringArray(getValueByAliases(projectCommands, ['testFull', 'test_full'])),
      lintFull: normalizeStringArray(getValueByAliases(projectCommands, ['lintFull', 'lint_full'])),
      typecheckFull: normalizeStringArray(getValueByAliases(projectCommands, ['typecheckFull', 'typecheck_full'])),
    },
    qualityGatePolicy: {
      tests: normalizeOptionalString(getValueByAliases(qualityGatePolicy, ['tests'])) ?? '',
      lint: normalizeOptionalString(getValueByAliases(qualityGatePolicy, ['lint'])) ?? '',
      typecheck: normalizeOptionalString(getValueByAliases(qualityGatePolicy, ['typecheck'])) ?? '',
      fullProjectFallback: normalizeOptionalString(getValueByAliases(qualityGatePolicy, ['fullProjectFallback', 'full_project_fallback'])) ?? '',
    },
    cautions: normalizeStringArray(getValueByAliases(record, ['cautions', 'warnings', 'notes'])),
  }
}

export function parseExecutionSetupProfile(content: string): ExecutionSetupProfileData | null {
  const parsed = tryParseStructuredContent(content)
  if (!isRecord(parsed)) return null
  return parseExecutionSetupProfileRecord(parsed)
}

function parseExecutionSetupChecks(value: unknown): ExecutionSetupRuntimeReportData['checks'] {
  if (!isRecord(value)) return null
  const workspace = normalizeOptionalString(getValueByAliases(value, ['workspace']))
  const tooling = normalizeOptionalString(getValueByAliases(value, ['tooling']))
  const tempScope = normalizeOptionalString(getValueByAliases(value, ['tempScope', 'temp_scope']))
  const policy = normalizeOptionalString(getValueByAliases(value, ['policy']))
  if (!workspace && !tooling && !tempScope && !policy) return null
  return {
    workspace: workspace ?? '',
    tooling: tooling ?? '',
    tempScope: tempScope ?? '',
    policy: policy ?? '',
  }
}

function parseExecutionSetupAttemptHistory(value: unknown): ExecutionSetupAttemptHistoryEntryData[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry, index) => ({
      attempt: normalizeNumber(getValueByAliases(entry, ['attempt'])) ?? index + 1,
      status: normalizeOptionalString(getValueByAliases(entry, ['status'])) ?? 'unknown',
      checkedAt: normalizeOptionalString(getValueByAliases(entry, ['checkedAt', 'checked_at'])),
      summary: normalizeOptionalString(getValueByAliases(entry, ['summary'])),
      tempRoots: normalizeStringArray(getValueByAliases(entry, ['tempRoots', 'temp_roots'])),
      bootstrapCommands: normalizeStringArray(getValueByAliases(entry, ['bootstrapCommands', 'bootstrap_commands'])),
      toolingProbeCommands: normalizeStringArray(getValueByAliases(entry, ['toolingProbeCommands', 'tooling_probe_commands'])),
      errors: normalizeStringArray(getValueByAliases(entry, ['errors'])),
      failureReason: normalizeOptionalString(getValueByAliases(entry, ['failureReason', 'failure_reason'])),
      noteAppended: normalizeOptionalString(getValueByAliases(entry, ['noteAppended', 'note_appended'])),
    }))
}

export function parseExecutionSetupRuntimeReport(content: string): ExecutionSetupRuntimeReportData | null {
  const parsed = tryParseStructuredContent(content)
  if (!isRecord(parsed)) return null

  const profileRaw = getValueByAliases(parsed, ['profile'])
  const profile = isRecord(profileRaw) ? parseExecutionSetupProfileRecord(profileRaw) : null
  const checks = parseExecutionSetupChecks(getValueByAliases(parsed, ['checks']))
  const status = normalizeOptionalString(getValueByAliases(parsed, ['status']))
  const readyRaw = getValueByAliases(parsed, ['ready'])
  const modelOutput = normalizeOptionalString(getValueByAliases(parsed, ['modelOutput', 'model_output']))
  const rawAttempts = normalizeRawAttempts(getValueByAliases(parsed, ['rawAttempts', 'raw_attempts']))
  const errors = normalizeStringArray(getValueByAliases(parsed, ['errors']))
  const worktreeWarnings = normalizeStringArray(getValueByAliases(parsed, ['worktreeWarnings', 'worktree_warnings']))
  const attemptHistory = parseExecutionSetupAttemptHistory(getValueByAliases(parsed, ['attemptHistory', 'attempt_history']))

  if (
    !status
    && typeof readyRaw !== 'boolean'
    && !profile
    && !checks
    && !modelOutput
    && !rawAttempts
    && errors.length === 0
    && worktreeWarnings.length === 0
    && attemptHistory.length === 0
  ) {
    return null
  }

  const maxIterationsRaw = getValueByAliases(parsed, ['maxIterations', 'max_iterations'])
  return {
    status,
    ready: typeof readyRaw === 'boolean' ? readyRaw : undefined,
    checkedAt: normalizeOptionalString(getValueByAliases(parsed, ['checkedAt', 'checked_at'])),
    preparedBy: normalizeOptionalString(getValueByAliases(parsed, ['preparedBy', 'prepared_by'])),
    summary: normalizeOptionalString(getValueByAliases(parsed, ['summary'])),
    profile,
    checks,
    modelOutput,
    rawAttempts,
    errors,
    worktreeWarnings,
    structuredOutput: normalizeArtifactStructuredOutput(getValueByAliases(parsed, ['structuredOutput', 'structured_output'])),
    attempt: normalizeNumber(getValueByAliases(parsed, ['attempt'])),
    maxIterations: maxIterationsRaw === null ? null : normalizeNumber(maxIterationsRaw),
    attemptHistory,
    retryNotes: normalizeStringArray(getValueByAliases(parsed, ['retryNotes', 'retry_notes'])),
    approvedPlanCommands: normalizeStringArray(getValueByAliases(parsed, ['approvedPlanCommands', 'approved_plan_commands'])),
    executionAddedCommands: normalizeStringArray(getValueByAliases(parsed, ['executionAddedCommands', 'execution_added_commands'])),
  }
}

function normalizeUiRefinementDiff(value: unknown): UiRefinementDiffArtifact | undefined {
  if (typeof value === 'string') {
    return parseUiRefinementDiffArtifact(value) ?? undefined
  }
  if (!isRecord(value)) return undefined
  return parseUiRefinementDiffArtifact(JSON.stringify(value)) ?? undefined
}

export function normalizeArtifactStructuredOutput(value: unknown): ArtifactStructuredOutputData | undefined {
  if (!isRecord(value)) return undefined

  const repairApplied = typeof value.repairApplied === 'boolean' ? value.repairApplied : false
  const repairWarnings = Array.isArray(value.repairWarnings)
    ? value.repairWarnings.filter((warning): warning is string => typeof warning === 'string')
    : []
  const autoRetryCount = typeof value.autoRetryCount === 'number' && Number.isInteger(value.autoRetryCount)
    ? value.autoRetryCount
    : 0
  const validationError = typeof value.validationError === 'string' && value.validationError.trim()
    ? value.validationError
    : undefined
  const retryDiagnostics = normalizeStructuredRetryDiagnostics(value.retryDiagnostics)
  const interventions = normalizeStructuredInterventions(value.interventions)

  return {
    repairApplied,
    repairWarnings,
    autoRetryCount,
    ...(validationError ? { validationError } : {}),
    ...(retryDiagnostics.length > 0 ? { retryDiagnostics } : {}),
    ...(interventions.length > 0 ? { interventions } : {}),
  }
}

export function normalizeRefinementDraftMetrics(
  value: unknown,
): RefinementDiffArtifactData['draftMetrics'] | undefined {
  if (!isRecord(value)) return undefined

  const epicCount = typeof value.epicCount === 'number' && Number.isInteger(value.epicCount)
    ? value.epicCount
    : null
  const userStoryCount = typeof value.userStoryCount === 'number' && Number.isInteger(value.userStoryCount)
    ? value.userStoryCount
    : null

  if (epicCount == null || userStoryCount == null) {
    return undefined
  }

  return { epicCount, userStoryCount }
}

function normalizeCandidateVersion(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined
}

function normalizeCoverageGapResolutionItem(value: unknown): CoverageGapResolutionItemData | null {
  if (!isRecord(value)) return null
  const itemType = value.itemType === 'epic' || value.itemType === 'user_story' || value.itemType === 'bead'
    ? value.itemType
    : value.item_type === 'epic' || value.item_type === 'user_story' || value.item_type === 'bead'
      ? value.item_type
      : null
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const label = typeof value.label === 'string' ? value.label.trim() : ''
  if (!itemType || !id || !label) return null
  return { itemType, id, label }
}

function normalizeCoverageGapResolutions(value: unknown): CoverageGapResolutionData[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const gap = typeof entry.gap === 'string' ? entry.gap.trim() : ''
    const action = entry.action === 'updated_prd'
      || entry.action === 'updated_beads'
      || entry.action === 'already_covered'
      || entry.action === 'left_unresolved'
      ? entry.action
      : null
    const rationale = typeof entry.rationale === 'string' ? entry.rationale.trim() : ''
    if (!gap || !action || !rationale) return []
    const rawItems = Array.isArray(entry.affectedItems)
      ? entry.affectedItems
      : Array.isArray(entry.affected_items)
        ? entry.affected_items
        : []
    return [{
      gap,
      action,
      rationale,
      affectedItems: rawItems
        .map((item) => normalizeCoverageGapResolutionItem(item))
        .filter((item): item is CoverageGapResolutionItemData => Boolean(item)),
    }]
  })
}

function buildRefinementCoveragePayload(
  coverageArtifact: CoverageArtifactData | null,
): Partial<CoverageArtifactData> {
  if (!coverageArtifact) return {}

  return {
    response: coverageArtifact.response,
    hasGaps: coverageArtifact.hasGaps,
    normalizedContent: coverageArtifact.normalizedContent,
    coverageRunNumber: coverageArtifact.coverageRunNumber,
    maxCoveragePasses: coverageArtifact.maxCoveragePasses,
    limitReached: coverageArtifact.limitReached,
    terminationReason: coverageArtifact.terminationReason,
    followUpBudgetPercent: coverageArtifact.followUpBudgetPercent,
    followUpBudgetTotal: coverageArtifact.followUpBudgetTotal,
    followUpBudgetUsed: coverageArtifact.followUpBudgetUsed,
    followUpBudgetRemaining: coverageArtifact.followUpBudgetRemaining,
    status: coverageArtifact.status,
    summary: coverageArtifact.summary,
    gaps: coverageArtifact.gaps,
    auditNotes: coverageArtifact.auditNotes,
    finalCandidateVersion: coverageArtifact.finalCandidateVersion,
    attempts: coverageArtifact.attempts,
    transitions: coverageArtifact.transitions,
    hasRemainingGaps: coverageArtifact.hasRemainingGaps,
    remainingGaps: coverageArtifact.remainingGaps,
    latestExtraFixSummary: coverageArtifact.latestExtraFixSummary,
    parsed: coverageArtifact.parsed,
  }
}

export function parseRefinementArtifact(content: string): RefinementDiffArtifactData | null {
  const parsed = tryParseStructuredContent(content)
  if (!isRecord(parsed)) return null

  const refinedContent = typeof parsed.refinedContent === 'string' ? parsed.refinedContent : ''
  if (!refinedContent.trim()) return null

  return {
    winnerId: typeof parsed.winnerId === 'string' ? parsed.winnerId : undefined,
    refinedContent,
    winnerDraftContent: typeof parsed.winnerDraftContent === 'string' ? parsed.winnerDraftContent : undefined,
    semanticPlanContent: typeof parsed.semanticPlanContent === 'string' ? parsed.semanticPlanContent : undefined,
    expandedContent: typeof parsed.expandedContent === 'string' ? parsed.expandedContent : undefined,
    coverageBaselineContent: typeof parsed.coverageBaselineContent === 'string' ? parsed.coverageBaselineContent : undefined,
    coverageBaselineVersion: normalizeCandidateVersion(parsed.coverageBaselineVersion),
    coverageDiffLabel: typeof parsed.coverageDiffLabel === 'string' && parsed.coverageDiffLabel.trim()
      ? parsed.coverageDiffLabel
      : undefined,
    changes: Array.isArray(parsed.changes) ? parsed.changes as RefinementChange[] : [],
    uiRefinementDiff: normalizeUiRefinementDiff(parsed.uiRefinementDiff),
    coverageUiRefinementDiff: normalizeUiRefinementDiff(parsed.coverageUiRefinementDiff),
    draftMetrics: normalizeRefinementDraftMetrics(parsed.draftMetrics),
    structuredOutput: normalizeArtifactStructuredOutput(parsed.structuredOutput),
    candidateVersion: normalizeCandidateVersion(parsed.candidateVersion),
    gapResolutions: normalizeCoverageGapResolutions(parsed.gapResolutions ?? parsed.gap_resolutions),
    rawAttempts: normalizeRawAttempts(getValueByAliases(parsed, ['rawAttempts', 'raw_attempts'])),
  }
}

function extractLegacySynthesizedInterviewIds(repairWarnings: string[] | undefined): Set<string> {
  const synthesizedIds = new Set<string>()
  for (const warning of repairWarnings ?? []) {
    const match = warning.match(/Synthesized omitted interview refinement modified change for (\S+)/i)
    if (match?.[1]) synthesizedIds.add(match[1])
  }
  return synthesizedIds
}

function shouldSuppressNoOpUiDiffEntry(
  changeType: string,
  beforeText: string | undefined,
  afterText: string | undefined,
): boolean {
  if (changeType !== 'modified' && changeType !== 'replaced') return false
  if (typeof beforeText !== 'string' || typeof afterText !== 'string') return false
  return beforeText.trim() === afterText.trim()
}

function splitInterviewQuestionDiffText(text: string | undefined): {
  phase?: string
  question?: string
} {
  if (typeof text !== 'string') return {}
  const lines = text.split(/\r?\n/)
  const phaseMatch = lines[0]?.match(/^Phase:\s*(.+)$/i)
  if (!phaseMatch) return { question: text }

  const question = lines.slice(1).join('\n').trim()
  return {
    phase: phaseMatch[1]?.trim(),
    question: question || undefined,
  }
}

export function buildInterviewDiffEntries(content: string | undefined): InterviewDiffEntry[] {
  if (!content) return []
  try {
    const parsed = JSON.parse(content) as InterviewDiffArtifactData
    if (parsed.uiRefinementDiff?.domain === 'interview') {
      const phaseLookup = new Map(
        [...normalizeInterviewDiffQuestions(parsed.originalContent), ...normalizeInterviewDiffQuestions(parsed.refinedContent)]
          .map((question) => [question.id, question.phase] as const),
      )
      return parsed.uiRefinementDiff.entries.flatMap((entry, index) => {
        const id = entry.afterId || entry.beforeId || `Q${String(index + 1).padStart(2, '0')}`
        const inspiration: InspirationDiffSource | null = entry.inspiration
          ? {
              memberId: entry.inspiration.memberId,
              question: entry.inspiration.sourceText ?? entry.inspiration.sourceLabel,
              questionId: entry.inspiration.sourceId,
            }
          : null
        if (shouldSuppressNoOpUiDiffEntry(entry.changeType, entry.beforeText, entry.afterText)) {
          return []
        }

        const before = splitInterviewQuestionDiffText(entry.beforeText)
        const after = splitInterviewQuestionDiffText(entry.afterText)
        return [{
          key: entry.key,
          id,
          changeType: entry.changeType,
          phase: phaseLookup.get(id) ?? after.phase ?? before.phase,
          before: before.question,
          after: after.question,
          ...(inspiration ? { inspiration } : {}),
          attributionStatus: normalizeInterviewDiffAttributionStatus(entry.attributionStatus) ?? 'model_unattributed',
        }]
      })
    }
    if (Array.isArray(parsed.changes)) {
      const synthesizedIds = extractLegacySynthesizedInterviewIds(parsed.structuredOutput?.repairWarnings)
      return parsed.changes.flatMap((change, index) => {
        const normalizedType = typeof change?.type === 'string' ? change.type.toLowerCase() : ''
        if (
          normalizedType !== 'modified'
          && normalizedType !== 'replaced'
          && normalizedType !== 'added'
          && normalizedType !== 'removed'
        ) {
          return []
        }

        const before = normalizeInterviewDiffQuestionRecord(change.before, index)
        const after = normalizeInterviewDiffQuestionRecord(change.after, index)
        const id = after?.id || before?.id || `Q${String(index + 1).padStart(2, '0')}`
        const phase = after?.phase || before?.phase
        const beforeText = before?.question
        const afterText = after?.question

        const inspiration: InspirationDiffSource | null | undefined = change.inspiration
          ? {
              memberId: change.inspiration.memberId ?? '',
              question: change.inspiration.question?.question ?? '',
              questionId: change.inspiration.question?.id,
              phase: change.inspiration.question?.phase,
            }
          : change.inspiration === null ? null : undefined
        const attributionStatus = normalizeInterviewDiffAttributionStatus(change.attributionStatus)
          ?? (inspiration
            ? 'inspired'
            : synthesizedIds.has(id)
              ? 'synthesized_unattributed'
              : 'model_unattributed')
        if (shouldSuppressNoOpUiDiffEntry(normalizedType, beforeText, afterText)) {
          return []
        }

        return [{
          key: `${id}:${normalizedType}:${index}`,
          id,
          changeType: normalizedType as InterviewDiffEntry['changeType'],
          phase,
          before: beforeText,
          after: afterText,
          ...(inspiration !== undefined ? { inspiration } : {}),
          attributionStatus,
        }]
      })
    }

    if (!parsed.originalContent || !parsed.refinedContent) return []

    return buildInterviewUiRefinementDiffArtifact({
      winnerId: parsed.winnerId ?? '',
      winnerDraftContent: parsed.originalContent,
      refinedContent: parsed.refinedContent,
    }).entries.map((entry, index) => {
      const before = splitInterviewQuestionDiffText(entry.beforeText)
      const after = splitInterviewQuestionDiffText(entry.afterText)
      return {
        key: entry.key,
        id: entry.afterId || entry.beforeId || `Q${String(index + 1).padStart(2, '0')}`,
        changeType: entry.changeType,
        phase: after.phase ?? before.phase,
        before: before.question,
        after: after.question,
        inspiration: entry.inspiration
          ? {
              memberId: entry.inspiration.memberId,
              question: entry.inspiration.sourceText ?? entry.inspiration.sourceLabel,
              questionId: entry.inspiration.sourceId,
            }
          : null,
        attributionStatus: normalizeInterviewDiffAttributionStatus(entry.attributionStatus) ?? 'model_unattributed',
      }
    })
  } catch {
    return []
  }
}

export const buildQuestionDiffSegments = buildTextDiffSegments

export function buildFinalInterviewArtifactContent(
  voteContent: string | null | undefined,
  compiledContent: string | null | undefined,
  uiDiffContent?: string | null | undefined,
  compiledCompanionContent?: string | null | undefined,
  winnerArtifactContent?: string | null | undefined,
): string | null {
  if (!compiledContent) return null
  try {
    const compiled = JSON.parse(compiledContent) as {
      refinedContent?: string
      questionCount?: number
      questions?: unknown[]
      winnerId?: string
      changes?: unknown
      uiRefinementDiff?: unknown
      structuredOutput?: ArtifactStructuredOutputData
    }
    const compiledCompanion = parseArtifactCompanionPayload(compiledCompanionContent, 'interview_compiled')
    const refinedContent = typeof compiled.refinedContent === 'string' ? compiled.refinedContent : ''
    if (!refinedContent) return null

    const mergedVoteContent = mergeVoteArtifactContent(voteContent)
    const voteResult = mergedVoteContent ? tryParseCouncilResult(mergedVoteContent) : null
    const winnerId = compiled.winnerId
      ?? (typeof compiledCompanion?.winnerId === 'string' ? compiledCompanion.winnerId : undefined)
      ?? readWinnerIdFromArtifactContent(winnerArtifactContent)
      ?? voteResult?.winnerId
    const winnerDraft = voteResult?.winnerId
      ? (voteResult.drafts ?? []).find((draft) => draft.memberId === voteResult.winnerId)
      : null

    const payload: InterviewDiffArtifactData = {
      winnerId,
      originalContent: winnerDraft?.content,
      refinedContent,
      originalQuestionCount: winnerDraft?.content
        ? normalizeInterviewDiffQuestions(winnerDraft.content).length
        : undefined,
      refinedQuestionCount: typeof compiled.questionCount === 'number'
        ? compiled.questionCount
        : Array.isArray(compiled.questions)
          ? compiled.questions.length
          : typeof compiledCompanion?.questionCount === 'number'
            ? compiledCompanion.questionCount
          : normalizeInterviewDiffQuestions(refinedContent).length,
      questionCount: typeof compiled.questionCount === 'number'
        ? compiled.questionCount
        : Array.isArray(compiled.questions)
          ? compiled.questions.length
          : typeof compiledCompanion?.questionCount === 'number'
            ? compiledCompanion.questionCount
          : normalizeInterviewDiffQuestions(refinedContent).length,
      questions: Array.isArray(compiled.questions)
        ? compiled.questions
        : Array.isArray(compiledCompanion?.questions)
          ? compiledCompanion.questions
          : undefined,
      changes: Object.prototype.hasOwnProperty.call(compiled, 'changes') && Array.isArray(compiled.changes)
        ? compiled.changes as InterviewQuestionChange[]
        : undefined,
      uiRefinementDiff: normalizeUiRefinementDiff(compiled.uiRefinementDiff) ?? normalizeUiRefinementDiff(uiDiffContent),
      structuredOutput: compiled.structuredOutput ?? normalizeArtifactStructuredOutput(compiledCompanion?.structuredOutput),
    }
    return JSON.stringify(payload)
  } catch {
    return null
  }
}

export function buildFinalRefinementArtifactContent(
  refinedContent: string | null | undefined,
  uiDiffContent?: string | null | undefined,
  coverageInputContent?: string | null | undefined,
  refinedCompanionContent?: string | null | undefined,
  winnerArtifactContent?: string | null | undefined,
  latestRevisionContent?: string | null | undefined,
  coverageArtifactContent?: string | null | undefined,
): string | null {
  const refinedArtifact = refinedContent ? parseRefinementArtifact(refinedContent) : null
  const latestRevisionArtifact = latestRevisionContent ? parseRefinementArtifact(latestRevisionContent) : null
  const coverageArtifact = coverageArtifactContent ? parseCoverageArtifact(coverageArtifactContent) : null
  const coverageTransitions = coverageArtifact?.transitions ?? []
  const firstCoverageTransition = coverageTransitions[0]
  const latestCoverageTransition = coverageTransitions[coverageTransitions.length - 1]
  const hasCoverageTransitions = Boolean(firstCoverageTransition?.fromContent && latestCoverageTransition?.toContent)
  const coverageInput = coverageInputContent ? tryParseStructuredContent(coverageInputContent) : null
  const coverageRecord = isRecord(coverageInput) ? coverageInput : null
  const refinedCompanion = parseArtifactCompanionPayload(refinedCompanionContent)
  const sourceArtifact = latestRevisionArtifact ?? refinedArtifact
  const coveragePayload = buildRefinementCoveragePayload(coverageArtifact)

  const nextRefinedContent = latestCoverageTransition?.toContent
    ?? latestRevisionArtifact?.refinedContent
    ?? (typeof coverageRecord?.refinedContent === 'string'
      ? coverageRecord.refinedContent
      : typeof coverageRecord?.prd === 'string'
        ? coverageRecord.prd
        : sourceArtifact?.refinedContent ?? '')
  if (!nextRefinedContent.trim()) return null

  // Coverage views should show the current artifact under review, not reuse the
  // earlier winner-to-refined diff when no coverage-driven revision exists yet.
  if (coverageRecord && !hasCoverageTransitions && !latestRevisionArtifact) {
    const payload: RefinementDiffArtifactData & CoverageInputData = {
      ...coveragePayload,
      ...(coverageRecord as CoverageInputData),
      winnerId: sourceArtifact?.winnerId ?? readWinnerIdFromArtifactContent(winnerArtifactContent),
      refinedContent: nextRefinedContent,
      candidateVersion: typeof coverageRecord.candidateVersion === 'number'
        ? coverageRecord.candidateVersion
        : sourceArtifact?.candidateVersion,
      rawAttempts: sourceArtifact?.rawAttempts
        ?? normalizeRawAttempts(getValueByAliases(refinedCompanion ?? {}, ['rawAttempts', 'raw_attempts']))
        ?? undefined,
    }

    return JSON.stringify(payload)
  }

  const payload: RefinementDiffArtifactData & CoverageInputData = {
    ...coveragePayload,
    ...(coverageRecord ? coverageRecord as CoverageInputData : {}),
    winnerId: sourceArtifact?.winnerId ?? readWinnerIdFromArtifactContent(winnerArtifactContent),
    refinedContent: nextRefinedContent,
    ...(hasCoverageTransitions
      ? {
          coverageBaselineContent: firstCoverageTransition?.fromContent,
          coverageBaselineVersion: firstCoverageTransition?.fromVersion,
          coverageDiffLabel: 'Diff vs v1',
          coverageUiRefinementDiff: latestCoverageTransition?.uiRefinementDiff ?? undefined,
        }
      : {
          winnerDraftContent: sourceArtifact?.winnerDraftContent
      ?? (typeof refinedCompanion?.winnerDraftContent === 'string' ? refinedCompanion.winnerDraftContent : undefined),
          changes: sourceArtifact?.changes,
          uiRefinementDiff: sourceArtifact?.uiRefinementDiff ?? normalizeUiRefinementDiff(uiDiffContent),
        }),
    draftMetrics: sourceArtifact?.draftMetrics ?? normalizeRefinementDraftMetrics(refinedCompanion?.draftMetrics),
    semanticPlanContent: sourceArtifact?.semanticPlanContent,
    expandedContent: sourceArtifact?.expandedContent,
    structuredOutput: sourceArtifact?.structuredOutput
      ?? normalizeArtifactStructuredOutput(refinedCompanion?.structuredOutput)
      ?? coverageArtifact?.structuredOutput,
    rawAttempts: sourceArtifact?.rawAttempts
      ?? normalizeRawAttempts(getValueByAliases(refinedCompanion ?? {}, ['rawAttempts', 'raw_attempts']))
      ?? undefined,
    candidateVersion: coverageArtifact?.finalCandidateVersion
      ?? latestRevisionArtifact?.candidateVersion
      ?? (typeof coverageRecord?.candidateVersion === 'number'
        ? coverageRecord.candidateVersion
        : sourceArtifact?.candidateVersion),
    gapResolutions: sourceArtifact?.gapResolutions,
  }

  return JSON.stringify(payload)
}

export function buildCoverageArtifactContent(
  coverageContent: string | null | undefined,
  coverageCompanionContent?: string | null | undefined,
): string | null {
  return mergeCoverageArtifactContent(coverageContent, coverageCompanionContent)
}

export function normalizeCoverageFollowUpArtifacts(questions: unknown): CoverageFollowUpArtifactQuestion[] {
  if (!Array.isArray(questions)) return []
  return questions
    .filter((question): question is CoverageFollowUpArtifactQuestion => Boolean(question) && typeof question === 'object')
    .map((question) => ({
      id: typeof question.id === 'string' ? question.id : undefined,
      question: typeof question.question === 'string'
        ? question.question
        : typeof question.prompt === 'string'
          ? question.prompt
          : undefined,
      phase: typeof question.phase === 'string' ? question.phase : undefined,
      priority: typeof question.priority === 'string' ? question.priority : undefined,
      rationale: typeof question.rationale === 'string' ? question.rationale : undefined,
    }))
    .filter((question) => Boolean(question.question?.trim()))
}

export function parseCoverageArtifact(content: string): CoverageArtifactData | null {
  const parsed = tryParseStructuredContent(content)
  if (!parsed || typeof parsed !== 'object') return null

  const result = parsed as Record<string, unknown>
  if (
    !('response' in result)
    && !('hasGaps' in result)
    && !('winnerId' in result)
    && !('parsed' in result)
    && !('normalizedContent' in result)
    && !('attempts' in result)
    && !('transitions' in result)
    && !('status' in result)
  ) {
    return null
  }

  const parsedCoverage = isRecord(result.parsed)
    ? {
        status: typeof result.parsed.status === 'string' ? result.parsed.status : undefined,
        gaps: Array.isArray(result.parsed.gaps)
          ? result.parsed.gaps.filter((gap): gap is string => typeof gap === 'string' && gap.trim().length > 0)
          : undefined,
        followUpQuestions: normalizeCoverageFollowUpArtifacts(result.parsed.followUpQuestions),
        follow_up_questions: normalizeCoverageFollowUpArtifacts(result.parsed.follow_up_questions),
      }
    : undefined

  return {
    winnerId: typeof result.winnerId === 'string' ? result.winnerId : undefined,
    response: typeof result.response === 'string' ? result.response : undefined,
    hasGaps: typeof result.hasGaps === 'boolean' ? result.hasGaps : undefined,
    normalizedContent: typeof result.normalizedContent === 'string' ? result.normalizedContent : undefined,
    coverageRunNumber: typeof result.coverageRunNumber === 'number' ? result.coverageRunNumber : undefined,
    maxCoveragePasses: typeof result.maxCoveragePasses === 'number' ? result.maxCoveragePasses : undefined,
    limitReached: typeof result.limitReached === 'boolean' ? result.limitReached : undefined,
    terminationReason: typeof result.terminationReason === 'string' ? result.terminationReason : undefined,
    followUpBudgetPercent: typeof result.followUpBudgetPercent === 'number' ? result.followUpBudgetPercent : undefined,
    followUpBudgetTotal: typeof result.followUpBudgetTotal === 'number' ? result.followUpBudgetTotal : undefined,
    followUpBudgetUsed: typeof result.followUpBudgetUsed === 'number' ? result.followUpBudgetUsed : undefined,
    followUpBudgetRemaining: typeof result.followUpBudgetRemaining === 'number' ? result.followUpBudgetRemaining : undefined,
    status: typeof result.status === 'string' ? result.status : parsedCoverage?.status,
    summary: typeof result.summary === 'string' ? result.summary : undefined,
    gaps: Array.isArray(result.gaps)
      ? result.gaps.filter((gap): gap is string => typeof gap === 'string' && gap.trim().length > 0)
      : parsedCoverage?.gaps,
    auditNotes: typeof result.auditNotes === 'string' ? result.auditNotes : undefined,
    finalCandidateVersion: normalizeCandidateVersion(result.finalCandidateVersion),
    attempts: Array.isArray(result.attempts)
      ? result.attempts.flatMap((attempt) => {
          if (!isRecord(attempt)) return []
          const candidateVersion = normalizeCandidateVersion(attempt.candidateVersion)
          const status = attempt.status === 'clean' || attempt.status === 'gaps' ? attempt.status : null
          const summary = typeof attempt.summary === 'string' ? attempt.summary.trim() : ''
          const auditNotes = typeof attempt.auditNotes === 'string' ? attempt.auditNotes : ''
          if (!candidateVersion || !status || !summary) return []
          return [{
            candidateVersion,
            status,
            summary,
            gaps: Array.isArray(attempt.gaps)
              ? attempt.gaps.filter((gap): gap is string => typeof gap === 'string' && gap.trim().length > 0)
              : [],
            auditNotes,
            response: typeof attempt.response === 'string' ? attempt.response : undefined,
            normalizedContent: typeof attempt.normalizedContent === 'string' ? attempt.normalizedContent : undefined,
            structuredOutput: normalizeArtifactStructuredOutput(attempt.structuredOutput),
            rawAttempts: normalizeRawAttempts(getValueByAliases(attempt, ['rawAttempts', 'raw_attempts'])),
            coverageRunNumber: typeof attempt.coverageRunNumber === 'number' ? attempt.coverageRunNumber : undefined,
            maxCoveragePasses: typeof attempt.maxCoveragePasses === 'number' ? attempt.maxCoveragePasses : undefined,
            limitReached: typeof attempt.limitReached === 'boolean' ? attempt.limitReached : undefined,
            terminationReason: typeof attempt.terminationReason === 'string' ? attempt.terminationReason : null,
            source: typeof attempt.source === 'string' ? attempt.source : undefined,
            extraFixNumber: typeof attempt.extraFixNumber === 'number' ? attempt.extraFixNumber : undefined,
          } satisfies CoverageAttemptData]
        })
      : undefined,
    transitions: Array.isArray(result.transitions)
      ? result.transitions.flatMap((transition) => {
          if (!isRecord(transition)) return []
          const fromVersion = normalizeCandidateVersion(transition.fromVersion)
          const toVersion = normalizeCandidateVersion(transition.toVersion)
          const summary = typeof transition.summary === 'string' ? transition.summary.trim() : ''
          const auditNotes = typeof transition.auditNotes === 'string' ? transition.auditNotes : ''
          const fromContent = typeof transition.fromContent === 'string' ? transition.fromContent : ''
          const toContent = typeof transition.toContent === 'string' ? transition.toContent : ''
          if (!fromVersion || !toVersion || !summary || !fromContent.trim() || !toContent.trim()) return []
          return [{
            fromVersion,
            toVersion,
            summary,
            gaps: Array.isArray(transition.gaps)
              ? transition.gaps.filter((gap): gap is string => typeof gap === 'string' && gap.trim().length > 0)
              : [],
            auditNotes,
            fromContent,
            toContent,
            gapResolutions: normalizeCoverageGapResolutions(transition.gapResolutions ?? transition.gap_resolutions) ?? [],
            resolutionNotes: Array.isArray(transition.resolutionNotes)
              ? transition.resolutionNotes.filter((note): note is string => typeof note === 'string' && note.trim().length > 0)
              : [],
            uiRefinementDiff: normalizeUiRefinementDiff(transition.uiRefinementDiff) ?? undefined,
            structuredOutput: normalizeArtifactStructuredOutput(transition.structuredOutput),
            rawAttempts: normalizeRawAttempts(getValueByAliases(transition, ['rawAttempts', 'raw_attempts'])),
            source: typeof transition.source === 'string' ? transition.source : undefined,
            extraFixNumber: typeof transition.extraFixNumber === 'number' ? transition.extraFixNumber : undefined,
            noChange: typeof transition.noChange === 'boolean' ? transition.noChange : undefined,
            label: typeof transition.label === 'string' ? transition.label : undefined,
          } satisfies CoverageTransitionData]
        })
      : undefined,
    hasRemainingGaps: typeof result.hasRemainingGaps === 'boolean' ? result.hasRemainingGaps : undefined,
    remainingGaps: Array.isArray(result.remainingGaps)
      ? result.remainingGaps.filter((gap): gap is string => typeof gap === 'string' && gap.trim().length > 0)
      : undefined,
    latestExtraFixSummary: typeof result.latestExtraFixSummary === 'string' ? result.latestExtraFixSummary : null,
    parsed: parsedCoverage,
    structuredOutput: normalizeArtifactStructuredOutput(result.structuredOutput),
    rawAttempts: normalizeRawAttempts(getValueByAliases(result, ['rawAttempts', 'raw_attempts'])),
  }
}

export function tryParseCouncilResult(content: string): CouncilResultData | null {
  try {
    const parsed = JSON.parse(content) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const result = parsed as CouncilResultData
    if (result.drafts || result.votes || result.winnerId) return result
    return null
  } catch {
    return null
  }
}

export function parseInterviewQuestions(content: string): { q: string; section?: string }[] {
  return extractInterviewQuestionPreviews(content)
    .map((question) => ({
      q: question.question,
      section: question.phase,
    }))
}

export function getArtifactTargetPhases(phase: string): string[] {
  const phaseMap: Record<string, string[]> = {
    WAITING_INTERVIEW_ANSWERS: ['WAITING_INTERVIEW_ANSWERS', 'COMPILING_INTERVIEW'],
    VERIFYING_INTERVIEW_COVERAGE: ['VERIFYING_INTERVIEW_COVERAGE', 'WAITING_INTERVIEW_ANSWERS', 'COMPILING_INTERVIEW'],
    WAITING_INTERVIEW_APPROVAL: ['VERIFYING_INTERVIEW_COVERAGE', 'WAITING_INTERVIEW_ANSWERS', 'COMPILING_INTERVIEW'],
    WAITING_PRD_APPROVAL: ['VERIFYING_PRD_COVERAGE', 'REFINING_PRD'],
    EXPANDING_BEADS: ['EXPANDING_BEADS', 'VERIFYING_BEADS_COVERAGE', 'REFINING_BEADS'],
    WAITING_BEADS_APPROVAL: ['EXPANDING_BEADS', 'VERIFYING_BEADS_COVERAGE', 'REFINING_BEADS'],
    WAITING_EXECUTION_SETUP_APPROVAL: ['WAITING_EXECUTION_SETUP_APPROVAL', 'PRE_FLIGHT_CHECK'],
    WAITING_PR_REVIEW: ['WAITING_PR_REVIEW', 'CREATING_PULL_REQUEST', 'INTEGRATING_CHANGES', 'RUNNING_FINAL_TEST', 'CODING'],
  }

  return phaseMap[phase] || [phase]
}

export function resolveStaticArtifact(
  artifactDef: ArtifactDef,
  phase: string,
  reversedArtifacts: DBartifact[],
): DBartifact | undefined {
  const targetPhases = getArtifactTargetPhases(phase)
  const findExactType = (artifactType: string) =>
    reversedArtifacts.find(artifact => targetPhases.includes(artifact.phase) && artifact.artifactType === artifactType)
  const findByPredicate = (predicate: (artifact: DBartifact) => boolean) =>
    reversedArtifacts.find(artifact => targetPhases.includes(artifact.phase) && predicate(artifact))

  switch (artifactDef.id) {
    case 'winner-draft':
      return findExactType('interview_votes')
    case 'vote-details':
      if (phase.includes('PRD')) return findExactType('prd_votes')
      if (phase.includes('BEADS')) return findExactType('beads_votes')
      return findExactType('interview_votes')
    case 'final-interview':
      if (phase === 'VERIFYING_INTERVIEW_COVERAGE' || phase === 'WAITING_INTERVIEW_APPROVAL') {
        return findExactType('interview_coverage_input') ?? findExactType('interview_compiled')
      }
      return findExactType('interview_compiled')
    case 'winner-prd-draft':
      return findExactType('prd_votes')
    case 'winner-beads-draft':
      return findExactType('beads_votes')
    case 'interview-answers':
      if (phase === 'VERIFYING_INTERVIEW_COVERAGE' || phase === 'WAITING_INTERVIEW_APPROVAL') {
        return findExactType('interview_coverage_input')
      }
      return findExactType('interview_session')
    case 'refined-prd':
      return findExactType('prd_coverage_revision') ?? findExactType('prd_coverage_input') ?? findExactType('prd_refined')
    case 'final-prd-draft':
      return findExactType('prd_refined')
    case 'coverage-report':
      return phase.includes('BEADS')
        ? findExactType('beads_coverage') ?? findExactType('beads_coverage_revision')
        : findExactType('prd_coverage') ?? findExactType('prd_coverage_revision')
    case 'refined-beads':
      return findExactType('beads_coverage_revision') ?? findExactType('beads_coverage_input') ?? findExactType('beads_expanded') ?? findExactType('beads_refined')
    case 'final-beads-draft':
      return findExactType('beads_expanded') ?? findExactType('beads_refined')
    case 'relevant-files-scan':
      return findExactType('relevant_files_scan')
    case 'diagnostics':
      return findExactType('preflight_report')
    case 'execution-setup-plan':
      return findExactType('execution_setup_plan')
    case 'execution-setup-plan-report':
      return findExactType('execution_setup_plan_report')
    case 'execution-setup-runtime':
      return findExactType('execution_setup_report') ?? findExactType('execution_setup_profile')
    case 'execution-setup-profile':
      return findExactType('execution_setup_profile')
    case 'execution-setup-report':
      return findExactType('execution_setup_report')
    case 'bead-commits':
      return findByPredicate(artifact => artifact.artifactType.startsWith('bead_diff:'))
    case 'test-results':
      return findExactType('final_test_report')
    case 'manual-qa-checklist':
      return findExactType('manual_qa_checklist')
    case 'commit-summary':
      return findExactType('integration_report')
    case 'pull-request-report':
      return findExactType('pull_request_report')
    case 'cleanup-report':
      return findExactType('cleanup_report')
  }

  const prefix = artifactDef.id.split('-')[0] ?? ''
  return findByPredicate(artifact => artifact.artifactType.toLowerCase().includes(prefix))
    ?? findByPredicate(artifact => Boolean(artifact.content))
}

export function buildRefinementDiffEntries(
  content: string | undefined,
  domain?: 'prd' | 'beads',
): RefinementDiffEntry[] {
  if (!content) return []
  const parsed = parseRefinementArtifact(content)
  if (!parsed) return []

  const preferredUiDiff = parsed.coverageUiRefinementDiff ?? parsed.uiRefinementDiff

  if (preferredUiDiff && (preferredUiDiff.domain === 'prd' || preferredUiDiff.domain === 'beads')) {
    const preferredEntries = preferredUiDiff.entries.flatMap((entry) => {
      if (entry.changeType === 'replaced') return []
      if (shouldSuppressNoOpUiDiffEntry(entry.changeType, entry.beforeText, entry.afterText)) return []
      return [{
        key: entry.key,
        changeType: entry.changeType,
        itemKind: entry.itemKind,
        label: entry.label,
        beforeId: entry.beforeId,
        afterId: entry.afterId,
        beforeText: entry.beforeText,
        afterText: entry.afterText,
        inspiration: entry.inspiration
          ? {
              memberId: entry.inspiration.memberId,
              sourceId: entry.inspiration.sourceId,
              sourceLabel: entry.inspiration.sourceLabel,
              sourceText: entry.inspiration.sourceText,
              blocks: entry.inspiration.blocks,
            }
          : null,
        attributionStatus: normalizeRefinementDiffAttributionStatus(entry.attributionStatus) ?? 'model_unattributed',
      }]
    })

    if (preferredEntries.length > 0) {
      return preferredEntries
    }
  }

  if (parsed.coverageBaselineContent && parsed.refinedContent && domain) {
    const fallbackArtifact = domain === 'prd'
      ? buildPrdUiRefinementDiffArtifact({
          winnerId: parsed.winnerId ?? '',
          winnerDraftContent: parsed.coverageBaselineContent,
          refinedContent: parsed.refinedContent,
        })
      : buildBeadsUiRefinementDiffArtifact({
          winnerId: parsed.winnerId ?? '',
          winnerDraftContent: parsed.coverageBaselineContent,
          refinedContent: parsed.refinedContent,
        })

    return fallbackArtifact.entries.flatMap((entry) => {
      if (entry.changeType === 'replaced') return []
      return [{
        key: entry.key,
        changeType: entry.changeType,
        itemKind: entry.itemKind,
        label: entry.label,
        beforeId: entry.beforeId,
        afterId: entry.afterId,
        beforeText: entry.beforeText,
        afterText: entry.afterText,
        inspiration: entry.inspiration
          ? {
              memberId: entry.inspiration.memberId,
              sourceId: entry.inspiration.sourceId,
              sourceLabel: entry.inspiration.sourceLabel,
              sourceText: entry.inspiration.sourceText,
              blocks: entry.inspiration.blocks,
            }
          : null,
        attributionStatus: normalizeRefinementDiffAttributionStatus(entry.attributionStatus) ?? 'model_unattributed',
      }]
    })
  }

  if (parsed.winnerDraftContent && parsed.refinedContent && domain) {
    const fallbackArtifact = domain === 'prd'
      ? buildPrdUiRefinementDiffArtifact({
          winnerId: parsed.winnerId ?? '',
          winnerDraftContent: parsed.winnerDraftContent,
          refinedContent: parsed.refinedContent,
        })
      : buildBeadsUiRefinementDiffArtifact({
          winnerId: parsed.winnerId ?? '',
          winnerDraftContent: parsed.winnerDraftContent,
          refinedContent: parsed.refinedContent,
        })

    return fallbackArtifact.entries.flatMap((entry) => {
      if (entry.changeType === 'replaced') return []
      return [{
        key: entry.key,
        changeType: entry.changeType,
        itemKind: entry.itemKind,
        label: entry.label,
        beforeId: entry.beforeId,
        afterId: entry.afterId,
        beforeText: entry.beforeText,
        afterText: entry.afterText,
        inspiration: entry.inspiration
          ? {
              memberId: entry.inspiration.memberId,
              sourceId: entry.inspiration.sourceId,
              sourceLabel: entry.inspiration.sourceLabel,
              sourceText: entry.inspiration.sourceText,
              blocks: entry.inspiration.blocks,
            }
          : null,
        attributionStatus: normalizeRefinementDiffAttributionStatus(entry.attributionStatus) ?? 'model_unattributed',
      }]
    })
  }

  if (!Array.isArray(parsed.changes)) return []

  return parsed.changes.flatMap((change, index) => {
    const normalizedType = typeof change?.type === 'string' ? change.type.toLowerCase() : ''
    if (normalizedType !== 'modified' && normalizedType !== 'added' && normalizedType !== 'removed') {
      return []
    }

    const afterId = change.after?.id
    const beforeId = change.before?.id
    const key = `${afterId || beforeId || index}:${normalizedType}:${index}`

    const rawInspiration = change.inspiration as Record<string, unknown> | null | undefined
    const rawItem = rawInspiration?.item
    const itemRecord = isRecord(rawItem) ? rawItem : null
    const inspiration = rawInspiration
      ? {
          memberId: String(rawInspiration.memberId ?? rawInspiration.alternative_draft ?? rawInspiration.alternativeDraft ?? ''),
          sourceId: typeof rawItem === 'string' ? '' : String(itemRecord?.id ?? ''),
          sourceLabel: typeof rawItem === 'string' ? rawItem : String(itemRecord?.label ?? ''),
          sourceText: typeof rawItem === 'string' ? rawItem : String(itemRecord?.detail ?? itemRecord?.label ?? ''),
        }
      : rawInspiration === null ? null : undefined
    const attributionStatus = normalizeRefinementDiffAttributionStatus(change.attributionStatus)
      ?? (inspiration ? 'inspired' : 'model_unattributed')

    return [{
      key,
      changeType: normalizedType as RefinementDiffEntry['changeType'],
      itemKind: change.itemType ?? 'item',
      label: change.after?.label ?? change.before?.label ?? change.after?.id ?? change.before?.id ?? key,
      beforeId: change.before?.id,
      beforeText: change.before?.label,
      afterId: change.after?.id,
      afterText: change.after?.label,
      ...(inspiration !== undefined ? { inspiration } : {}),
      attributionStatus,
    }]
  })
}

export function shouldCollapseVotingMemberArtifacts(phase: string): boolean {
  return phase === 'COUNCIL_VOTING_INTERVIEW' || phase === 'COUNCIL_VOTING_PRD' || phase === 'COUNCIL_VOTING_BEADS'
}
