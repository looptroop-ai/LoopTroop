import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as jsYaml from 'js-yaml'
import type { TicketContext, TicketEvent } from '../../machines/types'
import {
  getActivePhaseAttempt,
  getLatestPhaseArtifact,
  getTicketPaths,
  insertPhaseArtifact,
  upsertLatestPhaseArtifact,
} from '../../storage/tickets'
import { isMockOpenCodeMode } from '../../opencode/factory'
import { withCommandLoggingAsync } from '../../log/commandLogger'
import { throwIfAborted } from '../../council/types'
import { formatPromptText, runOpenCodePrompt, runOpenCodeSessionPrompt } from '../runOpenCodePrompt'
import { buildMinimalContext, type TicketState } from '../../opencode/contextBuilder'
import { SessionManager } from '../../opencode/sessionManager'
import { rewriteCandidateCommitWithFiles } from '../../phases/integration/squash'
import {
  buildCandidateFileAuditPrompt,
  buildCandidateFileAuditReport,
  buildIncludeAllCandidateFileAudit,
  CANDIDATE_DIFF_ARTIFACT,
  CANDIDATE_FILE_AUDIT_ARTIFACT,
  parseCandidateChangedFiles,
  parseCandidateFileAuditResponse,
  type CandidateFileAuditReport,
} from '../../phases/integration/candidateFileAudit'
import { pushBranchRef } from '../../git/push'
import { readWorktreeGitHookPolicy, shouldBypassGitHooks } from '../../git/hookPolicy'
import { parseYamlOrJsonCandidate } from '../../structuredOutput/yamlUtils'
import {
  captureGitRecoveryReceipt,
  createOrUpdateDraftPullRequest,
  ensureWorktreeClean,
  getPullRequestForBranch,
  markPullRequestReady,
  mergePullRequest,
  readGitDiff,
  tryDeleteRemoteBranch,
  verifyRemoteBaseContainsCommit,
  type PullRequestInfo,
  type PullRequestState,
} from '../../git/github'
import {
  createOpenCodeStreamState,
  emitAiMilestone,
  emitOpenCodePromptLog,
  emitOpenCodeSessionLogs,
  emitOpenCodeStreamEvent,
  emitPhaseLog,
  loadTicketDirContext,
  resolveAiResponseRuntimeSettings,
  resolveStructuredRetryRuntimeSettings,
} from './helpers'
import { adapter } from './state'
import { handleMockExecutionUnsupported } from './executionPhase'
import { MAX_DIFF_PATCH_LENGTH } from '../../lib/constants'
import { getErrorMessage } from '@shared/typeGuards'
import { buildStructuredRetryPrompt, buildStructuredOutputMetadata, type StructuredOutputMetadata } from '../../structuredOutput'
import { getStructuredRetryDecision } from '../../lib/structuredOutputRetry'
import { resolveStructuredRetryDiagnostic } from '../../lib/structuredRetryDiagnostics'
import { appendAcceptedRawAttempt, appendRejectedRawAttempt } from '../../lib/structuredRawAttempts'
import type { RawAttempt } from '../../council/types'
import { readManualQaDeliverySummaryForTicket } from '../../phases/manualQa/delivery'
import type { WorkflowPhaseId } from '@shared/workflowMeta'

const PULL_REQUEST_REPORT_ARTIFACT = 'pull_request_report'
const MERGE_REPORT_ARTIFACT = 'merge_report'
const GIT_RECOVERY_RECEIPT_ARTIFACT = 'git_recovery_receipt'
const PULL_REQUEST_DRAFT_SCHEMA_REMINDER = [
  'Return strict YAML only with exactly these top-level keys: title, summary, why, what_changed, validation, follow_ups.',
  '`title` must be a non-empty single-line string.',
  '`summary`, `why`, `what_changed`, and `validation` must be non-empty YAML string lists.',
  '`follow_ups` must be a YAML string list and may be empty.',
  'Do not include markdown fences, prose outside YAML, or extra top-level keys.',
].join('\n')

interface PullRequestDraftPayload {
  title?: unknown
  summary?: unknown
  why?: unknown
  what_changed?: unknown
  validation?: unknown
  follow_ups?: unknown
}

export interface PullRequestReport {
  status: 'passed' | 'failed'
  completedAt: string
  baseBranch: string
  headBranch: string
  candidateCommitSha: string | null
  prNumber: number | null
  prUrl: string | null
  prState: PullRequestState | null
  prHeadSha: string | null
  title: string | null
  body: string | null
  candidateFileAudit?: CandidateFileAuditReport | null
  structuredOutput?: StructuredOutputMetadata
  rawAttempts?: RawAttempt[]
  createdAt: string | null
  updatedAt: string | null
  mergedAt: string | null
  closedAt: string | null
  message: string
}

export interface CandidateDiffReport {
  status: 'passed'
  capturedAt: string
  baseCommit: string
  candidateCommitSha: string
  stat: string
  nameStatus: string
  patch: string
  patchTruncated: boolean
  patchError: string | null
}

export interface MergeCompletionReport {
  status: 'passed'
  completedAt: string
  disposition: 'merged' | 'closed_unmerged'
  baseBranch: string
  headBranch: string
  candidateCommitSha: string | null
  prNumber: number | null
  prUrl: string | null
  prState: PullRequestState | null
  prHeadSha: string | null
  localBaseHead: string | null
  remoteBaseHead: string | null
  remoteBranchDeleteWarning: string | null
  /** Why the operator finished without merging. Null for a merge, and for a close with no reason given. */
  closeReason: string | null
  message: string
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value.trim()]
  }
  return []
}

function parsePullRequestDraftResponse(response: string, fallbackTitle: string): {
  title: string
  body: string
} {
  let parsed: PullRequestDraftPayload | null = null

  try {
    const loaded = parseYamlOrJsonCandidate(response) as PullRequestDraftPayload | null
    parsed = loaded && typeof loaded === 'object' ? loaded : null
  } catch {
    parsed = null
  }

  if (!parsed) {
    throw new Error('Pull request draft output was not valid YAML.')
  }

  const title = typeof parsed.title === 'string' && parsed.title.trim().length > 0
    ? parsed.title.trim()
    : fallbackTitle

  const summary = normalizeStringArray(parsed.summary)
  const why = normalizeStringArray(parsed.why)
  const whatChanged = normalizeStringArray(parsed.what_changed)
  const validation = normalizeStringArray(parsed.validation)
  const followUps = normalizeStringArray(parsed.follow_ups)

  if (summary.length === 0 || why.length === 0 || whatChanged.length === 0 || validation.length === 0) {
    throw new Error('Pull request draft output was missing one or more required sections.')
  }

  const renderSection = (heading: string, items: string[]) => [
    `## ${heading}`,
    ...items.map((item) => `- ${item}`),
  ].join('\n')

  const sections = [
    renderSection('Summary', summary),
    renderSection('Why', why),
    renderSection('What Changed', whatChanged),
    renderSection('Validation', validation),
  ]

  if (followUps.length > 0) {
    sections.push(renderSection('Follow-ups', followUps))
  }

  return {
    title,
    body: sections.join('\n\n'),
  }
}

function buildFallbackPullRequestDraft(input: {
  fallbackTitle: string
  ticketTitle: string
  ticketDescription: string | null
  finalTestReport: string
}): {
  title: string
  body: string
} {
  const summary = input.ticketTitle.trim()
    ? `Completed ${input.ticketTitle.trim()}.`
    : 'Completed the LoopTroop ticket.'
  const why = input.ticketDescription?.trim()
    ? input.ticketDescription.trim()
    : 'The ticket requested this implementation.'
  const validation = input.finalTestReport.trim()
    ? 'See the attached final test report generated by LoopTroop.'
    : 'Final validation details were not available in the PR drafting context.'

  return {
    title: input.fallbackTitle,
    body: [
      '## Summary',
      `- ${summary}`,
      '',
      '## Why',
      `- ${why}`,
      '',
      '## What Changed',
      '- See the final diff on this branch for the implemented changes.',
      '',
      '## Validation',
      `- ${validation}`,
    ].join('\n'),
  }
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 18))}\n\n[truncated by LoopTroop]`
}

export function buildManualQaPullRequestSection(rawSummary: string): string {
  if (!rawSummary.trim()) return ''
  let parsed: Record<string, unknown> | null = null
  try {
    const value = jsYaml.load(rawSummary)
    parsed = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return ''
  }
  if (!parsed) return ''
  if (parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
    parsed = parsed.value as Record<string, unknown>
  }

  const outcome = typeof parsed.outcome === 'string'
    ? parsed.outcome
    : typeof parsed.status === 'string'
      ? parsed.status
      : null
  if (!outcome) return ''
  const stringList = (value: unknown) => Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
  const fixBeadIds = stringList(parsed.createdFixBeadIds ?? parsed.created_fix_bead_ids)
  const improvementTicketIds = stringList(parsed.improvementTicketIds ?? parsed.improvement_ticket_ids)
  const waivedItemIds = stringList(parsed.waivedItemIds ?? parsed.waived_item_ids)
  const skipReason = typeof parsed.skipReason === 'string'
    ? parsed.skipReason.trim()
    : typeof parsed.skip_reason === 'string'
      ? parsed.skip_reason.trim()
      : ''
  const bullets = [
    `- Outcome: ${outcome.replaceAll('_', ' ')}`,
    ...(fixBeadIds.length > 0 ? [`- Created fix beads: ${fixBeadIds.join(', ')}`] : []),
    ...(improvementTicketIds.length > 0 ? [`- Created improvement tickets: ${improvementTicketIds.join(', ')}`] : []),
    ...(waivedItemIds.length > 0 ? [`- Waived checklist items: ${waivedItemIds.join(', ')}`] : []),
    ...(skipReason ? [`- Skip reason: ${skipReason}`] : []),
  ]
  return ['## Manual QA', ...bullets].join('\n')
}

export function buildPullRequestPrompt(input: {
  fallbackTitle: string
  contextParts: Array<{ source?: string; content: string }>
  integrationReport: string
  finalTestReport: string
  manualQaSummary?: string
  diffStat: string
  diffNameStatus: string
  diffPatch: string
}): string {
  const contextSections = formatContextSections(input.contextParts)

  return [
    'You are the main implementer who just finished this ticket and now need to write the draft pull request.',
    'Use the final diff as the source of truth for what changed.',
    'Use the ticket details and PRD to explain why the change exists.',
    'Use the final test report to describe validation accurately.',
    'Reflect the Manual QA outcome, waivers, skip state, created fix beads, and improvement tickets when supplied.',
    'Do not mention work that is not present in the final diff.',
    'Be concise, specific, and reviewer-friendly.',
    'Return strict YAML only with exactly these top-level keys:',
    'title, summary, why, what_changed, validation, follow_ups',
    '`title` must be a single-line string.',
    '`summary`, `why`, `what_changed`, and `validation` must be non-empty YAML string lists.',
    '`follow_ups` must be a YAML string list and may be empty.',
    `If you are unsure about the title, fall back to this exact title: "${input.fallbackTitle}"`,
    '',
    contextSections,
    '',
    '### integration_report',
    input.integrationReport.trim() || '[missing integration report]',
    '',
    '### final_test_report',
    input.finalTestReport.trim() || '[missing final test report]',
    '',
    '### manual_qa_summary',
    input.manualQaSummary?.trim() || '[Manual QA disabled or no completed outcome]',
    '',
    '### final_diff_stat',
    input.diffStat.trim() || '[empty diff stat]',
    '',
    '### final_diff_name_status',
    input.diffNameStatus.trim() || '[empty diff name/status]',
    '',
    '### final_diff_patch',
    input.diffPatch.trim() || '[empty diff patch]',
  ].join('\n')
}

function formatContextSections(contextParts: Array<{ source?: string; content: string }>): string {
  return contextParts
    .map((part) => {
      const label = part.source ?? 'context'
      return `### ${label}\n${part.content.trim() || '[empty]'}`
    })
    .join('\n\n')
}

function buildPullRequestReport(input: {
  baseBranch: string
  headBranch: string
  candidateCommitSha: string | null
  pr: PullRequestInfo
  title: string
  body: string
  candidateFileAudit?: CandidateFileAuditReport | null
  structuredOutput?: StructuredOutputMetadata
  rawAttempts?: RawAttempt[]
  message: string
}): PullRequestReport {
  return {
    status: 'passed',
    completedAt: new Date().toISOString(),
    baseBranch: input.baseBranch,
    headBranch: input.headBranch,
    candidateCommitSha: input.candidateCommitSha,
    prNumber: input.pr.number,
    prUrl: input.pr.url,
    prState: input.pr.state,
    prHeadSha: input.pr.headRefOid,
    title: input.title,
    body: input.body,
    ...(input.candidateFileAudit ? { candidateFileAudit: input.candidateFileAudit } : {}),
    ...(input.structuredOutput ? { structuredOutput: input.structuredOutput } : {}),
    ...(input.rawAttempts && input.rawAttempts.length > 0 ? { rawAttempts: input.rawAttempts } : {}),
    createdAt: input.pr.createdAt,
    updatedAt: input.pr.updatedAt,
    mergedAt: input.pr.mergedAt,
    closedAt: input.pr.closedAt,
    message: input.message,
  }
}

function recordGitRecoveryReceipt(ticketId: string, receipt: unknown, phase: WorkflowPhaseId) {
  upsertLatestPhaseArtifact(ticketId, GIT_RECOVERY_RECEIPT_ARTIFACT, phase, JSON.stringify(receipt))
}

function readIntegrationArtifact(ticketId: string) {
  const artifact = getLatestPhaseArtifact(ticketId, 'integration_report', 'INTEGRATING_CHANGES')
  if (!artifact?.content) {
    throw new Error('Integration report not found. Cannot create the pull request.')
  }

  const parsed = JSON.parse(artifact.content) as {
    candidateCommitSha?: unknown
    mergeBase?: unknown
  } & Record<string, unknown>
  const candidateCommitSha = typeof parsed.candidateCommitSha === 'string' && parsed.candidateCommitSha.trim().length > 0
    ? parsed.candidateCommitSha.trim()
    : null
  const mergeBase = typeof parsed.mergeBase === 'string' && parsed.mergeBase.trim().length > 0
    ? parsed.mergeBase.trim()
    : null

  if (!candidateCommitSha || !mergeBase) {
    throw new Error('Integration report is missing candidate commit metadata.')
  }

  return {
    raw: artifact.content,
    record: parsed,
    candidateCommitSha,
    mergeBase,
  }
}

function buildCandidateDiffReport(input: {
  baseCommit: string
  candidateCommitSha: string
  diff: ReturnType<typeof readGitDiff>
}): CandidateDiffReport {
  return {
    status: 'passed',
    capturedAt: new Date().toISOString(),
    baseCommit: input.baseCommit,
    candidateCommitSha: input.candidateCommitSha,
    stat: input.diff.stat,
    nameStatus: input.diff.nameStatus,
    patch: input.diff.patch,
    patchTruncated: input.diff.patchTruncated,
    patchError: input.diff.patchError,
  }
}

function persistIntegrationReportWithAudit(input: {
  ticketId: string
  integrationRecord: Record<string, unknown>
  candidateCommitSha: string
  candidateFileAudit: CandidateFileAuditReport
}): string {
  const nextRecord = {
    ...input.integrationRecord,
    candidateCommitSha: input.candidateCommitSha,
    candidateFileAudit: input.candidateFileAudit,
  }
  const content = JSON.stringify(nextRecord)
  upsertLatestPhaseArtifact(input.ticketId, 'integration_report', 'INTEGRATING_CHANGES', content)
  return content
}

async function runCandidateFileAudit(input: {
  ticketId: string
  context: TicketContext
  worktreePath: string
  fallbackTitle: string
  contextParts: Array<{ source?: string; content: string }>
  integrationRaw: string
  finalTestReport: string
  diff: ReturnType<typeof readGitDiff>
  mergeBase: string
  candidateCommitSha: string
  model: string
  variant?: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<CandidateFileAuditReport> {
  const changedFiles = parseCandidateChangedFiles(input.diff.nameStatus)
  if (changedFiles.length === 0) {
    return buildCandidateFileAuditReport({
      status: 'passed',
      baseCommit: input.mergeBase,
      originalCandidateCommitSha: input.candidateCommitSha,
      candidateCommitSha: input.candidateCommitSha,
      entries: [],
    })
  }

  const prompt = buildCandidateFileAuditPrompt({
    fallbackTitle: input.fallbackTitle,
    contextSections: formatContextSections(input.contextParts),
    integrationReport: input.integrationRaw,
    finalTestReport: input.finalTestReport,
    diffStat: input.diff.stat,
    diffNameStatus: input.diff.nameStatus,
    diffPatch: truncateText(input.diff.patch, MAX_DIFF_PATCH_LENGTH),
  })
  const streamState = createOpenCodeStreamState()
  let sessionId = ''

  try {
    const auditResult = await runOpenCodePrompt({
      adapter,
      projectPath: input.worktreePath,
      parts: [{ type: 'text', content: prompt }],
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      timeoutKind: 'ai_response',
      model: input.model,
      variant: input.variant,
      toolPolicy: 'disabled',
      sessionOwnership: {
        ticketId: input.ticketId,
        phase: 'CREATING_PULL_REQUEST',
        // CREATING_PULL_REQUEST is attempt-tracked, and a restart archives
        // attempt 1 — the literal made every later attempt's session claim
        // ownership of the archived one, as every other phase avoids doing.
        phaseAttempt: getActivePhaseAttempt(input.ticketId, 'CREATING_PULL_REQUEST') ?? 1,
        forceFresh: true,
        memberId: input.model,
        step: 'candidate_file_audit',
      },
      onSessionCreated: (session) => {
        sessionId = session.id
        emitAiMilestone(
          input.ticketId,
          input.context.externalId,
          'CREATING_PULL_REQUEST',
          `Candidate file audit session created for ${input.model} (session=${session.id}).`,
          `${session.id}:candidate-file-audit-created`,
          {
            modelId: input.model,
            sessionId: session.id,
            source: `model:${input.model}`,
          },
        )
      },
      onStreamEvent: (event) => {
        if (!sessionId) return
        emitOpenCodeStreamEvent(
          input.ticketId,
          input.context.externalId,
          'CREATING_PULL_REQUEST',
          input.model,
          sessionId,
          event,
          streamState,
        )
      },
      onPromptDispatched: (event) => {
        emitOpenCodePromptLog(
          input.ticketId,
          input.context.externalId,
          'CREATING_PULL_REQUEST',
          input.model,
          event,
        )
      },
      onPromptCompleted: (event) => {
        emitOpenCodeSessionLogs(
          input.ticketId,
          input.context.externalId,
          'CREATING_PULL_REQUEST',
          input.model,
          event.session.id,
          'candidate_file_audit',
          event.response,
          event.messages,
          streamState,
        )
      },
    })

    const repairWarnings: string[] = []
    const entries = parseCandidateFileAuditResponse(auditResult.response, changedFiles, repairWarnings)
    if (repairWarnings.length > 0) {
      emitPhaseLog(
        input.ticketId,
        input.context.externalId,
        'CREATING_PULL_REQUEST',
        'info',
        `Candidate file audit normalization applied repairs: ${repairWarnings.join(' | ')}`,
        { source: 'system', audience: 'all' },
      )
    }
    return buildCandidateFileAuditReport({
      status: 'passed',
      baseCommit: input.mergeBase,
      originalCandidateCommitSha: input.candidateCommitSha,
      candidateCommitSha: input.candidateCommitSha,
      entries,
      warnings: repairWarnings,
    })
  } catch (error) {
    if (input.signal?.aborted) throw error
    const warning = `Candidate file audit fell back to including all files: ${getErrorMessage(error)}`
    emitPhaseLog(
      input.ticketId,
      input.context.externalId,
      'CREATING_PULL_REQUEST',
      'info',
      warning,
      { source: 'system', audience: 'all' },
    )
    return buildIncludeAllCandidateFileAudit({
      changedFiles,
      baseCommit: input.mergeBase,
      originalCandidateCommitSha: input.candidateCommitSha,
      candidateCommitSha: input.candidateCommitSha,
      warning,
    })
  }
}

export function buildPullRequestContext(ticketId: string, context: TicketContext, description: string): {
  ticketState: TicketState
  contextParts: Array<{ source?: string; content: string }>
  finalTestReport: string
  manualQaSummary: string
} {
  const { ticketDir } = loadTicketDirContext(context)
  const ticketState: TicketState = {
    ticketId: context.externalId,
    title: context.title,
    description,
  }

  const prdPath = resolve(ticketDir, 'prd.yaml')

  if (existsSync(prdPath)) {
    try { ticketState.prd = readFileSync(prdPath, 'utf8') } catch { /* ignore */ }
  }

  const finalTestArtifact = getLatestPhaseArtifact(ticketId, 'final_test_report', 'RUNNING_FINAL_TEST')
  // Canonical files first, then the stored artifact — through the same reader
  // the integration phase uses. This path had its own fallback that unwrapped a
  // `value` key and handed whatever it found to the prompt without validating
  // it or refusing a failed outcome, so the two phases could describe the same
  // Manual QA run differently, or describe one the other had refused.
  const deliverySummary = readManualQaDeliverySummaryForTicket(ticketId)
  const manualQaSummary = deliverySummary ? JSON.stringify(deliverySummary) : ''
  return {
    ticketState,
    contextParts: buildMinimalContext('pull_request', ticketState),
    finalTestReport: finalTestArtifact?.content ?? '',
    manualQaSummary,
  }
}

export async function handleCreatePullRequest(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
  signal?: AbortSignal,
) {
  if (isMockOpenCodeMode()) {
    await handleMockExecutionUnsupported(ticketId, context, 'CREATING_PULL_REQUEST', sendEvent)
    return
  }

  return withCommandLoggingAsync(
    ticketId,
    context.externalId,
    'CREATING_PULL_REQUEST',
    async () => {
      const { worktreePath, ticket } = loadTicketDirContext(context)
      const paths = getTicketPaths(ticketId)
      if (!paths) {
        throw new Error(`Ticket workspace not initialized: missing ticket paths for ${context.externalId}`)
      }

      throwIfAborted(signal, ticketId)

      const headBranch = ticket.branchName?.trim() || context.externalId
      const baseBranch = paths.baseBranch
      const integration = readIntegrationArtifact(ticketId)
      const fallbackTitle = `${context.externalId}: ${context.title}`
      const { contextParts, finalTestReport, manualQaSummary } = buildPullRequestContext(
        ticketId,
        context,
        ticket?.description ?? '',
      )
      const mainImplementer = context.lockedMainImplementer
      if (!mainImplementer) {
        throw new Error('No locked main implementer is configured for pull request drafting.')
      }

      const aiResponseSettings = resolveAiResponseRuntimeSettings(context)
      let candidateCommitSha = integration.candidateCommitSha
      let integrationRaw = integration.raw
      let diff = readGitDiff(worktreePath, integration.mergeBase, candidateCommitSha)

      let candidateFileAudit = await runCandidateFileAudit({
        ticketId,
        context,
        worktreePath,
        fallbackTitle,
        contextParts,
        integrationRaw,
        finalTestReport,
        diff,
        mergeBase: integration.mergeBase,
        candidateCommitSha,
        model: mainImplementer,
        variant: context.lockedMainImplementerVariant ?? undefined,
        timeoutMs: aiResponseSettings.timeoutMs,
        signal,
      })

      if (candidateFileAudit.excludedFiles.length > 0) {
        const rewrite = rewriteCandidateCommitWithFiles(
          worktreePath,
          integration.mergeBase,
          candidateCommitSha,
          context.title,
          context.externalId,
          candidateFileAudit.includedFiles,
        )
        if (!rewrite.success || !rewrite.commitHash) {
          throw new Error(`Candidate file audit rewrite failed: ${rewrite.message}`)
        }
        candidateCommitSha = rewrite.commitHash
        candidateFileAudit = {
          ...candidateFileAudit,
          candidateCommitSha,
        }
        emitPhaseLog(
          ticketId,
          context.externalId,
          'CREATING_PULL_REQUEST',
          'info',
          `Candidate file audit excluded ${candidateFileAudit.excludedFiles.length} file(s) before PR push.`,
          {
            source: 'system',
            audience: 'all',
            excludedFiles: candidateFileAudit.excludedFiles,
            candidateCommitSha,
          },
        )
        diff = readGitDiff(worktreePath, integration.mergeBase, candidateCommitSha)
      }

      upsertLatestPhaseArtifact(ticketId, CANDIDATE_FILE_AUDIT_ARTIFACT, 'CREATING_PULL_REQUEST', JSON.stringify(candidateFileAudit))
      integrationRaw = persistIntegrationReportWithAudit({
        ticketId,
        integrationRecord: integration.record,
        candidateCommitSha,
        candidateFileAudit,
      })
      upsertLatestPhaseArtifact(ticketId, CANDIDATE_DIFF_ARTIFACT, 'CREATING_PULL_REQUEST', JSON.stringify(buildCandidateDiffReport({
        baseCommit: integration.mergeBase,
        candidateCommitSha,
        diff,
      })))

      const prompt = buildPullRequestPrompt({
        fallbackTitle,
        contextParts,
        integrationReport: integrationRaw,
        finalTestReport,
        manualQaSummary,
        diffStat: diff.stat,
        diffNameStatus: diff.nameStatus,
        diffPatch: truncateText(diff.patch, MAX_DIFF_PATCH_LENGTH),
      })

      const streamState = createOpenCodeStreamState()
      const draftSessionManager = new SessionManager(adapter)
      const initialInput = formatPromptText([{ type: 'text', content: prompt }])
      let sessionId = ''
      let draftSessionOpen = false

      const runFreshDraftPrompt = async (retry: boolean) => await runOpenCodePrompt({
        adapter,
        projectPath: worktreePath,
        parts: [{ type: 'text', content: prompt }],
        signal,
        timeoutMs: aiResponseSettings.timeoutMs,
        timeoutKind: 'ai_response',
        model: mainImplementer,
        variant: context.lockedMainImplementerVariant ?? undefined,
        toolPolicy: 'disabled',
        sessionOwnership: {
          ticketId,
          phase: 'CREATING_PULL_REQUEST',
          phaseAttempt: getActivePhaseAttempt(ticketId, 'CREATING_PULL_REQUEST') ?? 1,
          keepActive: true,
          forceFresh: true,
          memberId: mainImplementer,
        },
        onSessionCreated: (session) => {
          sessionId = session.id
          draftSessionOpen = true
          emitAiMilestone(
            ticketId,
            context.externalId,
            'CREATING_PULL_REQUEST',
            retry
              ? `PR drafting retry session created for ${mainImplementer} (session=${session.id}).`
              : `PR drafting session created for ${mainImplementer} (session=${session.id}).`,
            retry ? `${session.id}:pull-request-draft-retry-created` : `${session.id}:pull-request-draft-created`,
            {
              modelId: mainImplementer,
              sessionId: session.id,
              source: `model:${mainImplementer}`,
            },
          )
        },
        onStreamEvent: (event) => {
          if (!sessionId) return
          emitOpenCodeStreamEvent(
            ticketId,
            context.externalId,
            'CREATING_PULL_REQUEST',
            mainImplementer,
            sessionId,
            event,
            streamState,
          )
        },
        onPromptDispatched: (event) => {
          emitOpenCodePromptLog(
            ticketId,
            context.externalId,
            'CREATING_PULL_REQUEST',
            mainImplementer,
            event,
          )
        },
        onPromptCompleted: (event) => {
          emitOpenCodeSessionLogs(
            ticketId,
            context.externalId,
            'CREATING_PULL_REQUEST',
            mainImplementer,
            event.session.id,
            'pull_request_draft',
            event.response,
            event.messages,
            streamState,
          )
        },
      })

      const closeDraftSession = async (state: 'complete' | 'abandon') => {
        if (!draftSessionOpen || !sessionId) return
        if (state === 'complete') {
          await draftSessionManager.completeSession(sessionId)
        } else {
          await draftSessionManager.abandonSession(sessionId)
        }
        draftSessionOpen = false
      }

      let prDraft = buildFallbackPullRequestDraft({
        fallbackTitle,
        ticketTitle: context.title,
        ticketDescription: ticket?.description ?? null,
        finalTestReport,
      })
      const rawAttempts: RawAttempt[] = []
      const retryDiagnostics: NonNullable<StructuredOutputMetadata['retryDiagnostics']> = []
      const structuredRetryCount = resolveStructuredRetryRuntimeSettings(context).structuredRetryCount
      let retryAttemptsUsed = 0
      let prDraftStructuredOutput = buildStructuredOutputMetadata({
        autoRetryCount: 0,
        repairApplied: false,
        repairWarnings: [],
      })

      try {
        let draftResult = await runFreshDraftPrompt(false)
        let draftResponse = draftResult.response

        while (true) {
          try {
            prDraft = parsePullRequestDraftResponse(draftResponse, fallbackTitle)
            appendAcceptedRawAttempt(rawAttempts, {
              stage: 'pull_request_draft',
              rawResponse: draftResponse,
              initialInput,
            })
            break
          } catch (error) {
            const validationError = getErrorMessage(error)
            const retryDecision = getStructuredRetryDecision(draftResponse, draftResult.responseMeta)
            const rawAttempt = appendRejectedRawAttempt(rawAttempts, {
              stage: 'pull_request_draft',
              rawResponse: draftResponse,
              initialInput,
              validationError,
              failureClass: retryDecision.failureClass,
            })
            retryDiagnostics.push(resolveStructuredRetryDiagnostic({
              attempt: rawAttempt.attempt,
              rawResponse: draftResponse,
              validationError,
              failureClass: retryDecision.failureClass,
              error,
            }))
            prDraftStructuredOutput = buildStructuredOutputMetadata(prDraftStructuredOutput, {
              autoRetryCount: retryAttemptsUsed,
              validationError,
              retryDiagnostics,
            })

            if (retryAttemptsUsed >= structuredRetryCount) {
              emitPhaseLog(
                ticketId,
                context.externalId,
                'CREATING_PULL_REQUEST',
                'info',
                `PR draft output failed validation after ${structuredRetryCount} structured retry attempt(s); using fallback PR text: ${validationError}`,
              )
              break
            }

            retryAttemptsUsed += 1
            prDraftStructuredOutput = buildStructuredOutputMetadata(prDraftStructuredOutput, {
              autoRetryCount: retryAttemptsUsed,
            })
            const retryMode = retryDecision.reuseSession ? 'continued session' : 'fresh session'
            emitPhaseLog(
              ticketId,
              context.externalId,
              'CREATING_PULL_REQUEST',
              'info',
              `PR draft output failed validation; retrying structured output (${retryAttemptsUsed}/${structuredRetryCount}) in a ${retryMode}: ${validationError}`,
            )

            if (retryDecision.reuseSession) {
              const retryResult = await runOpenCodeSessionPrompt({
                adapter,
                session: draftResult.session,
                parts: buildStructuredRetryPrompt([], {
                  validationError,
                  rawResponse: draftResponse,
                  schemaReminder: PULL_REQUEST_DRAFT_SCHEMA_REMINDER,
                }),
                signal,
                timeoutMs: aiResponseSettings.timeoutMs,
                timeoutKind: 'ai_response',
                model: mainImplementer,
                variant: context.lockedMainImplementerVariant ?? undefined,
                toolPolicy: 'disabled',
                onStreamEvent: (event) => {
                  if (!sessionId) return
                  emitOpenCodeStreamEvent(
                    ticketId,
                    context.externalId,
                    'CREATING_PULL_REQUEST',
                    mainImplementer,
                    sessionId,
                    event,
                    streamState,
                  )
                },
                onPromptDispatched: (event) => {
                  emitOpenCodePromptLog(
                    ticketId,
                    context.externalId,
                    'CREATING_PULL_REQUEST',
                    mainImplementer,
                    event,
                  )
                },
                onPromptCompleted: (event) => {
                  emitOpenCodeSessionLogs(
                    ticketId,
                    context.externalId,
                    'CREATING_PULL_REQUEST',
                    mainImplementer,
                    event.session.id,
                    'pull_request_draft',
                    event.response,
                    event.messages,
                    streamState,
                  )
                },
              })
              draftResult = retryResult
              draftResponse = retryResult.response
            } else {
              draftResult = await runFreshDraftPrompt(true)
              draftResponse = draftResult.response
            }
          }
        }
        await closeDraftSession('complete')
      } catch (error) {
        await closeDraftSession('abandon')
        throw error
      }

      throwIfAborted(signal, ticketId)

      const manualQaSection = buildManualQaPullRequestSection(manualQaSummary)
      if (manualQaSection) {
        prDraft = {
          ...prDraft,
          body: `${prDraft.body}\n\n${manualQaSection}`,
        }
      }

      let pullRequest: PullRequestInfo | null = null
      let currentStep = 'push_candidate_branch'

      try {
        const pushResult = await pushBranchRef({
          projectPath: worktreePath,
          destinationBranch: headBranch,
          sourceRef: candidateCommitSha,
          forceWithLease: true,
          maxRetries: 1,
          bypassHooks: shouldBypassGitHooks(readWorktreeGitHookPolicy(worktreePath)),
        })
        if (!pushResult.pushed) {
          throw new Error(pushResult.error ?? `Failed to update remote branch ${headBranch}.`)
        }

        emitPhaseLog(
          ticketId,
          context.externalId,
          'CREATING_PULL_REQUEST',
          'info',
          `Updated remote ticket branch ${headBranch} to candidate ${candidateCommitSha}.`,
        )

        currentStep = 'create_or_update_pull_request'
        pullRequest = await createOrUpdateDraftPullRequest({
          projectPath: worktreePath,
          branchName: headBranch,
          baseBranch,
          title: prDraft.title,
          body: prDraft.body,
        })
      } catch (error) {
        const message = getErrorMessage(error)
        recordGitRecoveryReceipt(
          ticketId,
          captureGitRecoveryReceipt({
            projectPath: worktreePath,
            phase: 'CREATING_PULL_REQUEST',
            step: currentStep,
            error: message,
            branch: headBranch,
            baseBranch,
            candidateSha: candidateCommitSha,
            pr: pullRequest,
          }),
          'CREATING_PULL_REQUEST',
        )
        throw error
      }

      const report = buildPullRequestReport({
        baseBranch,
        headBranch,
        candidateCommitSha,
        pr: pullRequest,
        title: prDraft.title,
        body: prDraft.body,
        candidateFileAudit,
        structuredOutput: prDraftStructuredOutput,
        rawAttempts,
        message: `Draft pull request ready at ${pullRequest.url}.`,
      })

      upsertLatestPhaseArtifact(ticketId, PULL_REQUEST_REPORT_ARTIFACT, 'CREATING_PULL_REQUEST', JSON.stringify(report))
      emitPhaseLog(
        ticketId,
        context.externalId,
        'CREATING_PULL_REQUEST',
        'info',
        `Draft pull request ready: ${pullRequest.url}`,
        {
          prNumber: pullRequest.number,
          prUrl: pullRequest.url,
          prState: pullRequest.state,
        },
      )

      sendEvent({ type: 'PULL_REQUEST_READY' })
    },
    (phase, type, content) => emitPhaseLog(ticketId, context.externalId, phase, type, content),
  )
}

export function readPullRequestReport(ticketId: string): PullRequestReport | null {
  const artifact = getLatestPhaseArtifact(ticketId, PULL_REQUEST_REPORT_ARTIFACT)
  if (!artifact?.content) return null

  try {
    return JSON.parse(artifact.content) as PullRequestReport
  } catch {
    return null
  }
}

export function refreshPullRequestReport(ticketId: string, report: PullRequestReport) {
  upsertLatestPhaseArtifact(ticketId, PULL_REQUEST_REPORT_ARTIFACT, 'CREATING_PULL_REQUEST', JSON.stringify(report))
}

export function refreshPullRequestState(projectPath: string, branchName: string, baseBranch: string): Promise<PullRequestInfo | null> {
  return getPullRequestForBranch(projectPath, branchName, baseBranch)
}

function assertPullRequestMatchesExpected(input: {
  pr: PullRequestInfo
  baseBranch: string
  headBranch: string
  candidateCommitSha: string | null
}) {
  if (input.pr.baseRefName !== input.baseBranch) {
    throw new Error(`Pull request #${input.pr.number} targets ${input.pr.baseRefName}, expected ${input.baseBranch}.`)
  }
  if (input.pr.headRefName !== input.headBranch) {
    throw new Error(`Pull request #${input.pr.number} uses head branch ${input.pr.headRefName}, expected ${input.headBranch}.`)
  }
  if (!input.candidateCommitSha) return
  if (!input.pr.headRefOid) {
    throw new Error(`Pull request #${input.pr.number} does not expose a head SHA to compare with candidate ${input.candidateCommitSha}.`)
  }
  if (input.pr.headRefOid !== input.candidateCommitSha) {
    throw new Error(`Pull request #${input.pr.number} head ${input.pr.headRefOid} does not match candidate ${input.candidateCommitSha}.`)
  }
}

function verifyTicketWorktreeClean(ticketId: string) {
  const paths = getTicketPaths(ticketId)
  if (!paths || !existsSync(paths.worktreePath)) return
  ensureWorktreeClean(paths.worktreePath)
}

export async function completeMergedPullRequest(input: {
  ticketId: string
  externalId: string
  projectPath: string
  baseBranch: string
  headBranch: string
  candidateCommitSha: string | null
  prReport: PullRequestReport
  skipRemoteMerge?: boolean
}): Promise<MergeCompletionReport> {
  const existingPullRequest = await getPullRequestForBranch(input.projectPath, input.headBranch, input.baseBranch)
  if (!existingPullRequest) {
    throw new Error(`No pull request found for branch ${input.headBranch}.`)
  }

  let pr = existingPullRequest
  let currentStep = 'verify_pull_request_candidate'

  try {
    assertPullRequestMatchesExpected({
      pr,
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      candidateCommitSha: input.candidateCommitSha,
    })
    verifyTicketWorktreeClean(input.ticketId)

    if (!input.skipRemoteMerge && pr.state !== 'merged') {
      if (pr.state === 'draft') {
        currentStep = 'mark_pull_request_ready'
        pr = await markPullRequestReady(input.projectPath, pr.number)
        currentStep = 'verify_pull_request_candidate'
        assertPullRequestMatchesExpected({
          pr,
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          candidateCommitSha: input.candidateCommitSha,
        })
      }

      currentStep = 'merge_pull_request'
      pr = await mergePullRequest(input.projectPath, pr.number, pr.title)
    }

    if (pr.state !== 'merged') {
      throw new Error(`Pull request #${pr.number} did not report merged after merge completion; state is ${pr.state}.`)
    }

    currentStep = 'verify_remote_merge'
    const verificationSha = input.candidateCommitSha ?? pr.headRefOid
    const remoteVerification = await verifyRemoteBaseContainsCommit(input.projectPath, input.baseBranch, verificationSha ?? '')
    const remoteBranchDelete = pr.state === 'merged'
      ? await tryDeleteRemoteBranch(input.projectPath, input.headBranch)
      : { deleted: false, warning: null as string | null }

    const report: MergeCompletionReport = {
      status: 'passed',
      completedAt: new Date().toISOString(),
      disposition: 'merged',
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      candidateCommitSha: input.candidateCommitSha,
      prNumber: pr.number,
      prUrl: pr.url,
      prState: pr.state,
      prHeadSha: pr.headRefOid,
      localBaseHead: null,
      remoteBaseHead: remoteVerification.remoteBaseHead,
      remoteBranchDeleteWarning: remoteBranchDelete.warning,
      // A merge is not a skip, so there is nothing here to explain.
      closeReason: null,
      message: `Pull request merged into origin/${input.baseBranch}. Local checkout was not modified.`,
    }

    insertPhaseArtifact(input.ticketId, {
      phase: 'WAITING_PR_REVIEW',
      artifactType: MERGE_REPORT_ARTIFACT,
      content: JSON.stringify(report),
    })
    refreshPullRequestReport(input.ticketId, {
      ...input.prReport,
      completedAt: new Date().toISOString(),
      prNumber: pr.number,
      prUrl: pr.url,
      prState: pr.state,
      prHeadSha: pr.headRefOid,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      mergedAt: pr.mergedAt,
      closedAt: pr.closedAt,
      message: report.message,
    })

    return report
  } catch (error) {
    const message = getErrorMessage(error)
    recordGitRecoveryReceipt(
      input.ticketId,
      captureGitRecoveryReceipt({
        projectPath: input.projectPath,
        phase: 'WAITING_PR_REVIEW',
        step: currentStep,
        error: message,
        branch: input.headBranch,
        baseBranch: input.baseBranch,
        candidateSha: input.candidateCommitSha,
        pr,
      }),
      'WAITING_PR_REVIEW',
    )
    throw error
  }
}

export function completeCloseUnmerged(input: {
  ticketId: string
  baseBranch: string
  headBranch: string
  candidateCommitSha: string | null
  prReport: PullRequestReport | null
  /**
   * Passed in rather than assigned to the returned report by the caller: the
   * artifact is persisted inside this function, so mutating the return value
   * would leave the stored record without the reason.
   */
  reason?: string | null
}): MergeCompletionReport {
  const report: MergeCompletionReport = {
    status: 'passed',
    completedAt: new Date().toISOString(),
    disposition: 'closed_unmerged',
    baseBranch: input.baseBranch,
    headBranch: input.headBranch,
    candidateCommitSha: input.candidateCommitSha,
    prNumber: input.prReport?.prNumber ?? null,
    prUrl: input.prReport?.prUrl ?? null,
    prState: input.prReport?.prState ?? null,
    prHeadSha: input.prReport?.prHeadSha ?? null,
    localBaseHead: null,
    remoteBaseHead: null,
    remoteBranchDeleteWarning: null,
    closeReason: input.reason?.trim() || null,
    message: 'Ticket finished without merging the pull request. The pull request and remote branch were left untouched.',
  }

  insertPhaseArtifact(input.ticketId, {
    phase: 'WAITING_PR_REVIEW',
    artifactType: MERGE_REPORT_ARTIFACT,
    content: JSON.stringify(report),
  })

  return report
}

export { GIT_RECOVERY_RECEIPT_ARTIFACT, MERGE_REPORT_ARTIFACT, PULL_REQUEST_REPORT_ARTIFACT }
