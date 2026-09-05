import type { LogEntry } from '@/context/LogContext'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import { isBenignGitProbeErrorLine } from '@/context/logUtils'

interface FormattedLogLine {
  tagText: string | null
  tagTitle?: string
  bodyText: string
  visibleText: string
  copyText: string
}

/**
 * Which model a row belongs to. A row can say so in `modelId` or only in a
 * `model:<id>` source, and the per-model log tabs are built from either — so the
 * filter behind a tab has to accept either as well, or a tab that exists solely
 * because of a source-tagged row opens onto nothing.
 */
export function getEntryFullModelId(entry: LogEntry): string | null {
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

const AI_DETAIL_OUTPUT_KINDS = new Set(['text', 'assistant', 'prompt', 'reasoning', 'tool', 'step', 'session'])
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

function getCanonicalLogEntries(entries: LogEntry[]): LogEntry[] {
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
  if (entry.audience === 'debug' || entry.source === 'debug' || (hasLeadingLogTag(entry, 'DEBUG') && !isAiDetailOutput(entry))) return 'text-amber-600 dark:text-amber-400'
  if (entry.kind === 'tool' || entry.line.includes('[TOOL]')) return 'text-cyan-600 dark:text-cyan-400'
  if (entry.kind === 'error' || entry.source === 'error' || (hasLeadingLogTag(entry, 'ERROR') && !isAiDetailOutput(entry))) return 'text-red-600 dark:text-red-400'
  if (hasLeadingLogTag(entry, 'CMD')) return 'text-cyan-600 dark:text-cyan-400'
  if (entry.kind === 'reasoning') return 'text-purple-600 dark:text-purple-400'
  if (entry.kind === 'prompt') return 'text-blue-600 dark:text-blue-400'
  if (entry.kind === 'text') return 'text-emerald-600 dark:text-emerald-400'
  if (entry.audience === 'ai' || entry.source === 'opencode' || entry.source.startsWith('model:')) return 'text-green-600 dark:text-green-400'
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

function getEntryModelDisplayName(entry: LogEntry): string | null {
  const rawModelId = getEntryFullModelId(entry) ?? ''
  const displayName = rawModelId ? getModelDisplayName(rawModelId) : ''
  return displayName || null
}

function formatTaggedSegment(tag: string, entry: LogEntry, showModelName: boolean): Pick<FormattedLogLine, 'tagText' | 'tagTitle'> {
  const bareTag = tag.slice(1, -1)
  const fullModelId = getEntryFullModelId(entry)
  const visibleTag = bareTag === 'MODEL' ? 'OUTPUT' : bareTag
  const isStandardAiHeader = bareTag === 'MODEL' || bareTag === 'ASSISTANT' || bareTag === 'PROMPT' || bareTag === 'THINKING' || bareTag === 'TOOL'
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
      return canonicalEntries.filter(entry => getEntryFullModelId(entry) === tab)
  }
}

export function filterBeadLogEntries(entries: LogEntry[]): LogEntry[] {
  const canonicalEntries = getCanonicalLogEntries(entries)
  return canonicalEntries.filter(entry =>
    !(entry.audience === 'debug' || entry.source === 'debug' || entry.line.includes('[DEBUG]')),
  )
}

export const MULTI_MODEL_PHASES = new Set([
  'COUNCIL_DELIBERATING',
  'COUNCIL_VOTING_INTERVIEW',
  'DRAFTING_PRD',
  'COUNCIL_VOTING_PRD',
  'DRAFTING_BEADS',
  'COUNCIL_VOTING_BEADS',
])
