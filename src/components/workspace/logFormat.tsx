import type { LogEntry } from '@/context/LogContext'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import { isBenignGitProbeErrorLine } from '@/context/logUtils'

export interface FormattedLogLine {
  tagText: string | null
  tagTitle?: string
  bodyText: string
  visibleText: string
  copyText: string
}

function getEntryFullModelId(entry: LogEntry): string | null {
  if (entry.modelId) return entry.modelId
  return entry.source.startsWith('model:') ? entry.source.slice('model:'.length) : null
}

function getModelKey(entry: LogEntry): string | null {
  return getEntryFullModelId(entry)
}

function getPhaseModelKey(entry: LogEntry): string | null {
  const modelKey = getModelKey(entry)
  return modelKey ? `${entry.status}:${modelKey}` : null
}

function isLegacyTranscriptSummary(entry: LogEntry): boolean {
  return entry.entryId.endsWith(':transcript-summary')
}

function isLegacyDerivedSummary(entry: LogEntry): boolean {
  if (entry.kind !== 'text') return false

  if (
    entry.entryId.endsWith(':questions-preview')
    || entry.entryId.startsWith('compiled-questions:')
    || entry.entryId.startsWith('draft-summary:')
    || entry.entryId.startsWith('prd-draft-summary:')
    || entry.entryId.startsWith('prd-full-answers-summary:')
    || entry.entryId.startsWith('beads-draft-summary:')
    || entry.entryId.startsWith('refined-prd:')
  ) {
    return true
  }

  return entry.line.includes('Questions received from')
    || entry.line.includes('Compiled interview questions from')
}

function isCanonicalAiTextEntry(entry: LogEntry): boolean {
  return entry.audience === 'ai'
    && entry.kind === 'text'
    && !isLegacyTranscriptSummary(entry)
    && !isLegacyDerivedSummary(entry)
}

const AI_DETAIL_OUTPUT_KINDS = new Set(['text', 'prompt', 'reasoning', 'tool', 'step', 'session'])
const AI_DETAIL_SESSION_KINDS = new Set([...AI_DETAIL_OUTPUT_KINDS, 'error'])

function hasLeadingLogTag(entry: LogEntry, tag: string): boolean {
  return entry.line.trimStart().startsWith(`[${tag}]`)
}

function isAiDetailOutput(entry: LogEntry): boolean {
  return AI_DETAIL_OUTPUT_KINDS.has(entry.kind)
    && (
      entry.audience === 'ai'
      || entry.source === 'opencode'
      || entry.source.startsWith('model:')
      || Boolean(entry.sessionId)
      || Boolean(entry.modelId)
    )
}

function isSystemShapedAiDetail(entry: LogEntry): boolean {
  if (entry.audience !== 'all' || entry.source !== 'system') return false
  if (entry.sessionId && AI_DETAIL_SESSION_KINDS.has(entry.kind)) return true
  return Boolean(entry.modelId) && AI_DETAIL_OUTPUT_KINDS.has(entry.kind)
}

export function getCanonicalLogEntries(entries: LogEntry[]): LogEntry[] {
  const canonicalSessions = new Set<string>()
  const canonicalPhaseModels = new Set<string>()

  for (const entry of entries) {
    if (!isCanonicalAiTextEntry(entry)) continue
    if (entry.sessionId) canonicalSessions.add(entry.sessionId)
    const phaseModelKey = getPhaseModelKey(entry)
    if (phaseModelKey) canonicalPhaseModels.add(phaseModelKey)
  }

  return entries.filter((entry) => {
    if (isLegacyTranscriptSummary(entry)) {
      return entry.sessionId ? !canonicalSessions.has(entry.sessionId) : true
    }

    if (!isLegacyDerivedSummary(entry)) return true
    const phaseModelKey = getPhaseModelKey(entry)
    return phaseModelKey ? !canonicalPhaseModels.has(phaseModelKey) : true
  })
}

export function getEntryColor(entry: LogEntry): string {
  if (entry.audience === 'debug' || entry.source === 'debug' || (hasLeadingLogTag(entry, 'DEBUG') && !isAiDetailOutput(entry))) return 'text-amber-600'
  if (entry.kind === 'tool' || entry.line.includes('[TOOL]')) return 'text-cyan-500'
  if (entry.kind === 'error' || entry.source === 'error' || (hasLeadingLogTag(entry, 'ERROR') && !isAiDetailOutput(entry))) return 'text-red-500'
  if (hasLeadingLogTag(entry, 'CMD')) return 'text-cyan-500'
  if (entry.kind === 'reasoning') return 'text-purple-400'
  if (entry.kind === 'prompt') return 'text-blue-500'
  if (entry.kind === 'text') return 'text-emerald-600'
  if (entry.audience === 'ai' || entry.source === 'opencode' || entry.source.startsWith('model:')) return 'text-green-500'
  return 'text-foreground'
}

interface TimestampFormatOptions {
  includeMilliseconds?: boolean
}

function getTimestampPlaceholder(includeMilliseconds: boolean): string {
  return includeMilliseconds ? '--:--:--.---' : '--:--:--'
}

function resolveTimestampParts(
  timestamp?: string,
  options: TimestampFormatOptions = {},
): { timeString: string; milliseconds: string | null } | null {
  const { includeMilliseconds = true } = options
  if (!timestamp) return null
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return null

  const timeString = parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  return {
    timeString,
    milliseconds: includeMilliseconds ? parsed.getMilliseconds().toString().padStart(3, '0') : null,
  }
}

export function formatTimestampString(timestamp?: string, options: TimestampFormatOptions = {}): string {
  const { includeMilliseconds = true } = options
  const resolved = resolveTimestampParts(timestamp, options)
  if (!resolved) return getTimestampPlaceholder(includeMilliseconds)

  return resolved.milliseconds ? `${resolved.timeString}.${resolved.milliseconds}` : resolved.timeString
}

export function formatTimestamp(timestamp?: string, options: TimestampFormatOptions = {}): React.ReactNode {
  const { includeMilliseconds = true } = options
  const resolved = resolveTimestampParts(timestamp, options)
  if (!resolved) return getTimestampPlaceholder(includeMilliseconds)
  if (!resolved.milliseconds) return resolved.timeString

  return (
    <>
      {resolved.timeString}.<span className="opacity-40">{resolved.milliseconds}</span>
    </>
  )
}

export function getEntryModelDisplayName(entry: LogEntry): string | null {
  const rawModelId = getEntryFullModelId(entry) ?? ''
  const displayName = rawModelId ? getModelDisplayName(rawModelId) : ''
  return displayName || null
}

function formatTaggedSegment(tag: string, entry: LogEntry, showModelName: boolean): Pick<FormattedLogLine, 'tagText' | 'tagTitle'> {
  const bareTag = tag.slice(1, -1)
  const fullModelId = getEntryFullModelId(entry)
  const visibleTag = bareTag === 'MODEL' ? 'OUTPUT' : bareTag
  const isStandardAiHeader = bareTag === 'MODEL' || bareTag === 'PROMPT' || bareTag === 'THINKING' || bareTag === 'TOOL'
  const modelName = bareTag === 'ERROR' ? getEntryModelDisplayName(entry) : fullModelId
  const shouldShowModelName = Boolean(modelName) && (bareTag === 'ERROR' || (showModelName && isStandardAiHeader))

  if (!shouldShowModelName) {
    return { tagText: `[${visibleTag}]` }
  }

  return {
    tagText: `[${visibleTag}-${modelName}]`,
    ...(fullModelId ? { tagTitle: fullModelId } : {}),
  }
}

function removeDuplicatedPromptModel(bodyText: string, entry: LogEntry): string {
  const fullModelId = getEntryFullModelId(entry)
  if (!fullModelId) return bodyText

  const duplicatedPrefix = ` ${fullModelId} prompt #`
  return bodyText.startsWith(duplicatedPrefix)
    ? ` Prompt #${bodyText.slice(duplicatedPrefix.length)}`
    : bodyText
}

function formatCopyText(visibleText: string, entry: LogEntry): string {
  const fullModelId = getEntryFullModelId(entry)
  const closingBracket = visibleText.indexOf(']')
  const visibleHeaderContainsModel = fullModelId && closingBracket >= 0
    ? visibleText.slice(0, closingBracket + 1).includes(`-${fullModelId}]`)
    : false
  return fullModelId && !visibleHeaderContainsModel ? `${visibleText} [model: ${fullModelId}]` : visibleText
}

export function formatVisibleTag(tag: string, entry: LogEntry, showModelName: boolean): string {
  return formatTaggedSegment(tag, entry, showModelName).tagText ?? tag
}

export function formatLogLine(entry: LogEntry, showModelName: boolean): FormattedLogLine {
  const tagMatch = entry.line.match(/^(\[[^\]]+\])([\s\S]*)$/)
  if (tagMatch) {
    const [, rawTag = '', rawBodyText = ''] = tagMatch
    const { tagText, tagTitle } = formatTaggedSegment(rawTag, entry, showModelName)
    const bodyText = rawTag === '[PROMPT]' && showModelName
      ? removeDuplicatedPromptModel(rawBodyText, entry)
      : rawBodyText
    const visibleText = `${tagText}${bodyText}`
    return {
      tagText,
      ...(tagTitle ? { tagTitle } : {}),
      bodyText,
      visibleText,
      copyText: formatCopyText(visibleText, entry),
    }
  }

  if (entry.kind === 'reasoning') {
    const bodyText = ` ${entry.line}`
    const { tagText, tagTitle } = formatTaggedSegment('[THINKING]', entry, showModelName)
    const visibleText = `${tagText}${bodyText}`
    return {
      tagText,
      ...(tagTitle ? { tagTitle } : {}),
      bodyText,
      visibleText,
      copyText: formatCopyText(visibleText, entry),
    }
  }

  return {
    tagText: null,
    bodyText: entry.line,
    visibleText: entry.line,
    copyText: formatCopyText(entry.line, entry),
  }
}

export const isCommand = (entry: LogEntry) => hasLeadingLogTag(entry, 'CMD')
export const isSystem = (entry: LogEntry) => entry.audience === 'all' && entry.source === 'system' && !isSystemShapedAiDetail(entry)

export function filterEntries(entries: LogEntry[], tab: string): LogEntry[] {
  const canonicalEntries = getCanonicalLogEntries(entries)
  const isDebug = (entry: LogEntry) => entry.audience === 'debug' || entry.source === 'debug' || (hasLeadingLogTag(entry, 'DEBUG') && !isAiDetailOutput(entry))
  const isError = (entry: LogEntry) => (entry.kind === 'error' || entry.source === 'error' || (hasLeadingLogTag(entry, 'ERROR') && !isAiDetailOutput(entry))) && !isBenignGitProbeErrorLine(entry.line)
  const isPrompt = (entry: LogEntry) => entry.kind === 'prompt'
  const isFromOpenCode = (entry: LogEntry) =>
    entry.audience === 'ai' ||
    entry.source === 'opencode' ||
    entry.source.startsWith('model:') ||
    Boolean(entry.modelId) ||
    Boolean(entry.sessionId)
  const isOverviewAiEntry = (entry: LogEntry) =>
    entry.audience === 'ai'
    && ((entry.kind === 'text' && (!entry.streaming || entry.op === 'append')) || isLegacyTranscriptSummary(entry))

  switch (tab) {
    case 'ALL':
      return canonicalEntries.filter(entry => (((entry.audience === 'all' && !isCommand(entry)) || isError(entry) || isPrompt(entry) || isOverviewAiEntry(entry)) && !isDebug(entry)))
    case 'SYS':
      return canonicalEntries.filter(e => isSystem(e) && !isDebug(e))
    case 'CMD':
      return canonicalEntries.filter(e => isSystem(e) && isCommand(e) && !isDebug(e))
    case 'AI':
      return canonicalEntries.filter(isFromOpenCode)
    case 'ERROR':
      return canonicalEntries.filter(isError)
    case 'DEBUG':
      return canonicalEntries
    default:
      return canonicalEntries.filter(entry => entry.modelId === tab)
  }
}

export function filterBeadLogEntries(entries: LogEntry[]): LogEntry[] {
  const canonicalEntries = getCanonicalLogEntries(entries)
  return canonicalEntries.filter(entry =>
    !(entry.audience === 'debug' || entry.source === 'debug' || entry.line.includes('[DEBUG]')),
  )
}

export const PHASE_LOG_DESCRIPTIONS: Record<string, string> = {
  DRAFT: 'Ticket created and waiting to start.',
  SCANNING_RELEVANT_FILES: 'AI reads and extracts relevant source file contents for use as context in subsequent phases.',
  COUNCIL_DELIBERATING: 'Each council model generates an independent interview draft with questions in logical order.',
  COUNCIL_VOTING_INTERVIEW: 'Council members vote on all interview drafts using weighted scoring rubric.',
  COMPILING_INTERVIEW: 'Winning model incorporates best ideas from other drafts into a final normalized question set.',
  WAITING_INTERVIEW_ANSWERS: 'Interview questions presented to user for answers.',
  VERIFYING_INTERVIEW_COVERAGE: 'AI analyzes answers for coverage gaps, may add follow-up questions, and checks interview completeness.',
  WAITING_INTERVIEW_APPROVAL: 'Interview results ready for user review and approval before PRD drafting.',
  DRAFTING_PRD: 'Each council model creates its own Full Answers artifact, then generates an independent PRD draft with epics and user stories.',
  COUNCIL_VOTING_PRD: 'Council members vote on all PRD drafts using weighted scoring rubric.',
  REFINING_PRD: 'Winning model consolidates the best draft into PRD Candidate v1 using useful ideas from the losing proposals.',
  VERIFYING_PRD_COVERAGE: 'LoopTroop checks the current PRD against the winning model Full Answers artifact and, if needed, revises it before checking again.',
  WAITING_PRD_APPROVAL: 'Latest PRD candidate is ready for user review and approval, with the winning Full Answers available as read-only context.',
  DRAFTING_BEADS: 'Each council model creates an independent beads breakdown from the PRD.',
  COUNCIL_VOTING_BEADS: 'Council members vote on all beads drafts for best architecture.',
  REFINING_BEADS: 'Winning model consolidates the best beads draft into the final semantic blueprint using useful ideas from the losing proposals.',
  VERIFYING_BEADS_COVERAGE: 'LoopTroop checks the semantic beads blueprint against the approved PRD and revises it if gaps are found, up to a maximum number of passes.',
  EXPANDING_BEADS: 'LoopTroop transforms the coverage-validated semantic blueprint into execution-ready bead records with commands, file targets, and dependency graphs.',
  WAITING_BEADS_APPROVAL: 'Beads breakdown ready for user review and approval.',
  PRE_FLIGHT_CHECK: 'Validating OpenCode connectivity, git safety, tool availability, artifact paths, beads graph integrity.',
  PREPARING_EXECUTION_ENV: 'Verifying workspace readiness, provisioning missing required tooling in ticket-owned temp roots, using setup-scoped online lookup for unresolved launcher artifacts, validating setup wrappers/probes, recording provisioning-attempt evidence, and persisting a setup profile for later phases.',
  CODING: 'AI coding agent executes beads with retry loop (Ralph Wiggum loop) until all tasks + tests pass.',
  RUNNING_FINAL_TEST: 'Generating and running final tests from ticket details, PRD, beads, retry notes, and any validated setup wrapper.',
  GENERATING_QA_CHECKLIST: 'Preparing a versioned Manual QA checklist and advisory PRD coverage from the final-test checkpoint. No user action or application control occurs in this phase.',
  WAITING_MANUAL_QA: 'Waiting for user-run verification results, evidence, waivers, improvements, drift decisions, submission, or skip.',
  INTEGRATING_CHANGES: 'Squashing commits and preparing the final reviewable candidate commit.',
  CREATING_PULL_REQUEST: 'Pushing the final candidate branch and creating or updating the draft GitHub pull request.',
  WAITING_PR_REVIEW: 'Draft pull request ready for human review and finish decision.',
  CLEANING_ENV: 'Removing temporary files, worktrees, and processes created during execution.',
  COMPLETED: 'All phases completed successfully. Cleanup finished after either merging the PR or closing the ticket unmerged.',
  CANCELED: 'Ticket was canceled.',
  BLOCKED_ERROR: 'An error occurred during processing.',
}

export const MULTI_MODEL_PHASES = new Set([
  'COUNCIL_DELIBERATING',
  'COUNCIL_VOTING_INTERVIEW',
  'DRAFTING_PRD',
  'COUNCIL_VOTING_PRD',
  'DRAFTING_BEADS',
  'COUNCIL_VOTING_BEADS',
])
