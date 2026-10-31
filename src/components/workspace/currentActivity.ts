import type { LogEntry } from '@/context/LogContext'

export type CurrentActivityDiagnostic =
  | 'provider_retry_timeout'
  | 'provider_timeout_preserved'
  | 'iteration_timeout'
  | 'model_no_activity_timeout'
  | 'near_timeout'
  | 'empty_model_output'
  | 'workflow_timeout'

export type CurrentActivityKind =
  | 'waiting_first_model_activity'
  | 'provider_retrying'
  | CurrentActivityDiagnostic

export interface CurrentActivity {
  kind: CurrentActivityKind
  label: string
  diagnostic?: CurrentActivityDiagnostic
  active: boolean
  severity: 'info' | 'warning' | 'error'
  elapsedMs?: number
  modelId?: string
  sessionId?: string
  beadId?: string
}

interface IndexedEntry {
  entry: LogEntry
  index: number
  timeMs: number
}

interface DiagnosticCandidate {
  kind: CurrentActivityDiagnostic
  indexedEntry: IndexedEntry
}

interface CurrentActivityOptions {
  activeStatus?: string | null
  activePhaseAttempt?: number
  suppressNearTimeout?: boolean
}

const FIRST_ACTIVITY_KINDS = new Set([
  'reasoning',
  'text',
  'assistant',
  'model_output',
  'tool',
  'step',
  'question',
  'todo',
  'part_summary',
  'file_edit',
  'file-edited',
  'file_edited',
  'done',
])

const TRUSTED_DIAGNOSTIC_SOURCES = new Set(['error', 'system', 'opencode', 'workflow'])
const TRUSTED_DIAGNOSTIC_KINDS = new Set(['error', 'milestone', 'session'])
const NEAR_TIMEOUT_MIN_MS = 30_000
const NEAR_TIMEOUT_MAX_MS = 120_000
const NEAR_TIMEOUT_RATIO = 0.1

function parseTimeMs(timestamp?: string): number {
  if (!timestamp) return Number.NaN
  const timeMs = Date.parse(timestamp)
  return Number.isFinite(timeMs) ? timeMs : Number.NaN
}

function compareIndexedEntries(a: IndexedEntry, b: IndexedEntry): number {
  const aHasTime = Number.isFinite(a.timeMs)
  const bHasTime = Number.isFinite(b.timeMs)
  if (aHasTime && bHasTime && a.timeMs !== b.timeMs) return a.timeMs - b.timeMs
  if (aHasTime !== bHasTime) return aHasTime ? -1 : 1
  return a.index - b.index
}

function sortEntries(entries: LogEntry[]): IndexedEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, timeMs: parseTimeMs(entry.timestamp) }))
    .sort(compareIndexedEntries)
}

function getModelId(entry: LogEntry): string | undefined {
  if (entry.modelId) return entry.modelId
  if (entry.source.startsWith('model:')) return entry.source.slice('model:'.length)
  return undefined
}

function isPromptEntry(entry: LogEntry): boolean {
  return entry.kind === 'prompt'
}

function isFirstActivityEntry(entry: LogEntry): boolean {
  if (isPromptEntry(entry)) return false
  if (isStatusEntry(entry) && /^(?:\[SYS\]\s*)?First AI activity observed\b/i.test(entry.line)) return true
  return entry.audience === 'ai' && FIRST_ACTIVITY_KINDS.has(entry.kind)
}

function isProviderRetryEntry(entry: LogEntry): boolean {
  return isStatusEntry(entry)
    && /^(?:\[(?:SYS|ERROR)\]\s*)?Session (?:retry\b|status:\s*retry\b)/i.test(entry.line)
}

function isStatusEntry(entry: LogEntry): boolean {
  return ['milestone', 'session', 'error'].includes(entry.kind)
    && (TRUSTED_DIAGNOSTIC_SOURCES.has(entry.source) || entry.source.startsWith('model:'))
}

function isTrustedDiagnosticEntry(entry: LogEntry): boolean {
  return (entry.audience !== 'ai'
    && TRUSTED_DIAGNOSTIC_SOURCES.has(entry.source)
    && TRUSTED_DIAGNOSTIC_KINDS.has(entry.kind))
    || (entry.source.startsWith('model:') && entry.kind === 'error' && entry.entryId.endsWith(':draft-finished'))
}

function isProviderRetryTimeoutEntry(entry: LogEntry): boolean {
  return isTrustedDiagnosticEntry(entry)
    && /\bopencode retry (?:budget exhausted|grace window expired)\b/i.test(entry.line)
}

function isProviderTimeoutPreservedEntry(entry: LogEntry): boolean {
  return isTrustedDiagnosticEntry(entry)
    && /\bopencode\/provider timeout for session \S+;\s*preserving session for continue\b/i.test(entry.line)
}

function isEmptyModelOutputEntry(entry: LogEntry): boolean {
  return isTrustedDiagnosticEntry(entry)
    && (isPromptResultEntry(entry) && /\bresponseChars=0\b/i.test(entry.line)
      || /^(?:\[SYS\]\s*)?OpenCode returned no response text\b/.test(entry.line))
}

function isPromptResultEntry(entry: LogEntry): boolean {
  return isTrustedDiagnosticEntry(entry)
    && /\bOpenCode\b.+\bsession=\S+,\s*messages=\d+,\s*responseChars=\d+\b/i.test(entry.line)
}

function isPromptCompletionEntry(entry: LogEntry): boolean {
  if (!isStatusEntry(entry)) return false
  if (entry.kind === 'session' && /^(?:\[SYS\]\s*)?Session status:\s*idle\b/i.test(entry.line)) return true
  if (entry.kind === 'milestone' && /^(?:\[SYS\]\s*)?AI session completed\b/i.test(entry.line)) return true
  return isPromptResultEntry(entry)
}

function isPromptFailureEntry(entry: LogEntry): boolean {
  return isStatusEntry(entry) && !isProviderRetryEntry(entry) && (
    entry.kind === 'error'
    || /^(?:\[SYS\]\s*)?AI session failed\b/i.test(entry.line)
    || entry.entryId.endsWith(':draft-finished')
  )
}

function isIterationTimeoutEntry(entry: LogEntry): boolean {
  return isTrustedDiagnosticEntry(entry)
    && /\biteration timeout for bead \S+ attempt \d+;\s*resetting for attempt \d+(?: of \d+)?\b/i.test(entry.line)
}

function isTrustedPromptTimeoutEntry(entry: LogEntry): boolean {
  if (!isTrustedDiagnosticEntry(entry)) return false
  if (isProviderRetryTimeoutEntry(entry)) return false
  if (isProviderTimeoutPreservedEntry(entry)) return false
  if (isIterationTimeoutEntry(entry)) return false
  return /\bopencode prompt timed out after \d+ms\b/i.test(entry.line)
    || /^\[ERROR\]\s*Timeout\.?$/i.test(entry.line)
    || /\bAI response timeout reached after \d+ms\b/i.test(entry.line)
    || /\bworkflow(?: deadline)? timeout(?:\b| after\b)/i.test(entry.line)
    || /\bdeadline exceeded\b/i.test(entry.line)
}

function parseDeadlineMs(deadlineAt?: string): number {
  if (!deadlineAt) return Number.NaN
  const deadlineMs = Date.parse(deadlineAt)
  return Number.isFinite(deadlineMs) ? deadlineMs : Number.NaN
}

function getNearTimeoutWindowMs(timeoutMs: number): number {
  return Math.min(NEAR_TIMEOUT_MAX_MS, Math.max(NEAR_TIMEOUT_MIN_MS, timeoutMs * NEAR_TIMEOUT_RATIO))
}

function isNearTimeoutPrompt(prompt: LogEntry, nowMs: number): boolean {
  if (typeof prompt.timeoutMs !== 'number' || !Number.isFinite(prompt.timeoutMs) || prompt.timeoutMs <= 0) {
    return false
  }
  const deadlineMs = parseDeadlineMs(prompt.deadlineAt)
  if (!Number.isFinite(deadlineMs)) return false
  return nowMs >= deadlineMs - getNearTimeoutWindowMs(prompt.timeoutMs)
}

function getSessionId(entry: LogEntry): string | undefined {
  if (entry.sessionId) return entry.sessionId
  if (!isStatusEntry(entry)) return undefined
  const match = /\bsession\s*[=:]\s*([\w-]+)|\bfor session\s+([\w-]+)/i.exec(entry.line)
  return match?.[1] ?? match?.[2]
}

function getBeadId(entry: LogEntry): string | undefined {
  return entry.beadId || (isStatusEntry(entry)
    ? /\bbead(?:\s*[=:]\s*|\s+)([\w.-]+)/i.exec(entry.line)?.[1]
    : undefined)
}

function entryMatchesPrompt(entry: LogEntry, prompt: LogEntry): boolean {
  const sessionId = getSessionId(entry)
  if (sessionId) return sessionId === prompt.sessionId
  const beadId = getBeadId(entry)
  if (beadId && beadId !== prompt.beadId) return false
  const modelId = getModelId(entry)
  if (modelId && modelId !== getModelId(prompt)) return false
  return true
}

function entryRelatesToPrompt(indexed: IndexedEntry, prompt: LogEntry, prompts: IndexedEntry[]): boolean {
  if (!entryMatchesPrompt(indexed.entry, prompt)) return false
  if (getSessionId(indexed.entry)) return true
  // Missing attribution is safe only when exactly one dispatched prompt could own the row.
  return prompts.filter(candidate => compareIndexedEntries(candidate, indexed) < 0
    && entryMatchesPrompt(indexed.entry, candidate.entry)).length === 1
}

function buildDiagnosticActivity(
  kind: CurrentActivityDiagnostic,
  prompt: LogEntry,
  elapsedUntilMs: number,
): CurrentActivity {
  const elapsedMs = Number.isFinite(parseTimeMs(prompt.timestamp)) && Number.isFinite(elapsedUntilMs)
    ? Math.max(0, elapsedUntilMs - parseTimeMs(prompt.timestamp))
    : undefined

  switch (kind) {
    case 'provider_retry_timeout':
      return {
        kind,
        diagnostic: kind,
        active: false,
        severity: 'error',
        label: 'Provider retry timeout',
        elapsedMs,
        modelId: getModelId(prompt),
        sessionId: prompt.sessionId,
        beadId: prompt.beadId,
      }
    case 'provider_timeout_preserved':
      return {
        kind,
        diagnostic: kind,
        active: false,
        severity: 'warning',
        label: 'Provider timeout preserved for Continue',
        elapsedMs,
        modelId: getModelId(prompt),
        sessionId: prompt.sessionId,
        beadId: prompt.beadId,
      }
    case 'iteration_timeout':
      return {
        kind,
        diagnostic: kind,
        active: false,
        severity: 'error',
        label: 'Iteration timeout; retrying bead',
        elapsedMs,
        modelId: getModelId(prompt),
        sessionId: prompt.sessionId,
        beadId: prompt.beadId,
      }
    case 'model_no_activity_timeout':
      return {
        kind,
        diagnostic: kind,
        active: false,
        severity: 'error',
        label: 'Timed out before first model activity',
        elapsedMs,
        modelId: getModelId(prompt),
        sessionId: prompt.sessionId,
        beadId: prompt.beadId,
      }
    case 'near_timeout':
      return {
        kind,
        diagnostic: kind,
        active: true,
        severity: 'warning',
        label: 'Approaching timeout',
        elapsedMs,
        modelId: getModelId(prompt),
        sessionId: prompt.sessionId,
        beadId: prompt.beadId,
      }
    case 'empty_model_output':
      return {
        kind,
        diagnostic: kind,
        active: false,
        severity: 'warning',
        label: 'Model returned no visible output',
        elapsedMs,
        modelId: getModelId(prompt),
        sessionId: prompt.sessionId,
        beadId: prompt.beadId,
      }
    case 'workflow_timeout':
      return {
        kind,
        diagnostic: kind,
        active: false,
        severity: 'error',
        label: 'Workflow timeout',
        elapsedMs,
        modelId: getModelId(prompt),
        sessionId: prompt.sessionId,
        beadId: prompt.beadId,
      }
  }
}

function pickLatestDiagnostic(candidates: DiagnosticCandidate[]): DiagnosticCandidate | null {
  if (candidates.length === 0) return null
  return candidates.reduce((latest, candidate) => (
    compareIndexedEntries(candidate.indexedEntry, latest.indexedEntry) > 0 ? candidate : latest
  ))
}

export function formatElapsedDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes === 0) return `${seconds}s`

  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  if (hours === 0) return `${totalMinutes}m ${seconds}s`

  return `${hours}h ${minutes}m`
}

export function deriveCurrentActivities(
  entries: LogEntry[],
  nowMs = Date.now(),
  options: CurrentActivityOptions = {},
): CurrentActivity[] {
  let orderedEntries = sortEntries(entries)

  // Identify the current active status (ignoring BLOCKED_ERROR unless supplied
  // by the ticket). Phase-only log buckets need the ticket status to avoid
  // resurrecting stale timeout warnings when reviewing earlier phases.
  let activeStatus: string | undefined = options.activeStatus ?? undefined
  if (!activeStatus) {
    for (let i = orderedEntries.length - 1; i >= 0; i--) {
      const status = orderedEntries[i]!.entry.status
      if (status && status !== 'BLOCKED_ERROR') {
        activeStatus = status
        break
      }
    }
  }

  orderedEntries = orderedEntries.filter(({ entry }) => !activeStatus || entry.status === activeStatus)
  const activePhaseAttempt = options.activePhaseAttempt
    ?? orderedEntries.reduce((latest, { entry }) => Math.max(latest, entry.phaseAttempt ?? 1), 1)
  orderedEntries = orderedEntries.filter(({ entry }) => (entry.phaseAttempt ?? 1) === activePhaseAttempt)
  const prompts = orderedEntries.filter(({ entry }) => isPromptEntry(entry))

  const currentPrompts = prompts.filter((indexed, index) => {
    const prompt = indexed.entry
    return !prompts.slice(index + 1).some(newer => {
      if (prompt.sessionId && newer.entry.sessionId === prompt.sessionId) return true
      const sameModel = getModelId(prompt) === getModelId(newer.entry)
      const sameBead = prompt.beadId === newer.entry.beadId
      if (!sameModel || !sameBead) return false
      if (!prompt.sessionId && !newer.entry.sessionId) return true
      // A replacement session retires an ended attempt, but concurrent sessions stay separate.
      return orderedEntries.some(candidate => compareIndexedEntries(indexed, candidate) < 0
        && compareIndexedEntries(candidate, newer) < 0
        && entryMatchesPrompt(candidate.entry, prompt)
        && (getSessionId(candidate.entry) === prompt.sessionId
          || entryRelatesToPrompt(candidate, prompt, prompts))
        && (isPromptCompletionEntry(candidate.entry) || isPromptFailureEntry(candidate.entry)))
    })
  })

  const activities: CurrentActivity[] = []

  for (const promptIndexed of currentPrompts) {
    const prompt = promptIndexed.entry
    const promptTimeMs = promptIndexed.timeMs

    const promptIndex = orderedEntries.indexOf(promptIndexed)
    const entriesAfterPrompt = orderedEntries
      .slice(promptIndex + 1)
      .filter(indexed => entryRelatesToPrompt(indexed, prompt, currentPrompts))

    const firstActivityIndex = entriesAfterPrompt.findIndex(({ entry }) => isFirstActivityEntry(entry))
    const firstActivityEntry = firstActivityIndex >= 0 ? entriesAfterPrompt[firstActivityIndex]! : null
    const hasFirstActivity = firstActivityEntry !== null
    const promptCompletionEntry = entriesAfterPrompt.findLast(({ entry }) => isPromptCompletionEntry(entry))
    const diagnosticCandidates: DiagnosticCandidate[] = []

    for (const indexedEntry of entriesAfterPrompt) {
      const { entry } = indexedEntry
      if (isProviderRetryTimeoutEntry(entry)) {
        diagnosticCandidates.push({ kind: 'provider_retry_timeout', indexedEntry })
      } else if (isProviderTimeoutPreservedEntry(entry)) {
        diagnosticCandidates.push({ kind: 'provider_timeout_preserved', indexedEntry })
      } else if (isEmptyModelOutputEntry(entry)) {
        diagnosticCandidates.push({ kind: 'empty_model_output', indexedEntry })
      } else if (isIterationTimeoutEntry(entry)) {
        diagnosticCandidates.push({ kind: 'iteration_timeout', indexedEntry })
      } else if (isTrustedPromptTimeoutEntry(entry)
        || (isStatusEntry(entry) && entry.entryId.endsWith(':draft-finished') && /\bdraft timed out\b/i.test(entry.line))) {
        const activityStartedBeforeTimeout = firstActivityEntry
          ? compareIndexedEntries(firstActivityEntry, indexedEntry) < 0
          : false
        diagnosticCandidates.push({
          kind: activityStartedBeforeTimeout ? 'workflow_timeout' : 'model_no_activity_timeout',
          indexedEntry,
        })
      }
    }

    const latestDiagnostic = pickLatestDiagnostic(diagnosticCandidates)
    if (latestDiagnostic) {
      const recovered = entriesAfterPrompt.some(indexed => (
        compareIndexedEntries(indexed, latestDiagnostic.indexedEntry) > 0
        && isPromptResultEntry(indexed.entry) && !isEmptyModelOutputEntry(indexed.entry)
      ))
      if (recovered) continue
      activities.push(buildDiagnosticActivity(latestDiagnostic.kind, prompt, latestDiagnostic.indexedEntry.timeMs))
      continue
    }

    if (promptCompletionEntry || entriesAfterPrompt.some(({ entry }) => isPromptFailureEntry(entry))) continue

    const latestRetry = entriesAfterPrompt.findLast(({ entry }) => isProviderRetryEntry(entry))
    const retryStillActive = latestRetry && !entriesAfterPrompt.some(indexed => (
      compareIndexedEntries(indexed, latestRetry) > 0 && (
        isFirstActivityEntry(indexed.entry)
        || (isStatusEntry(indexed.entry) && /^(?:\[SYS\]\s*)?Session status:\s*busy\b/i.test(indexed.entry.line))
      )
    ))
    if (hasFirstActivity && !retryStillActive) continue

    // Question waits suspend every ticket budget, invalidating earlier dispatch deadlines.
    const deadlineWasSuspended = orderedEntries.slice(promptIndex + 1).some(({ entry }) => (
      entry.kind === 'session' && /^\[QUESTION\]/.test(entry.line)
    ))
    if (!options.suppressNearTimeout && !deadlineWasSuspended && isNearTimeoutPrompt(prompt, nowMs)) {
      const activity = buildDiagnosticActivity('near_timeout', prompt, nowMs)
      if (nowMs >= parseDeadlineMs(prompt.deadlineAt)) activity.label = 'Prompt deadline reached; awaiting outcome'
      activities.push(activity)
      continue
    }

    const elapsedMs = Number.isFinite(promptTimeMs) ? Math.max(0, nowMs - promptTimeMs) : undefined
    activities.push({
      kind: retryStillActive ? 'provider_retrying' : 'waiting_first_model_activity',
      active: true,
      severity: retryStillActive ? 'warning' : 'info',
      label: retryStillActive
        ? hasFirstActivity ? 'Provider retrying' : 'Provider retrying before first model activity'
        : 'Waiting for first model activity',
      elapsedMs,
      modelId: getModelId(prompt),
      sessionId: prompt.sessionId,
      beadId: prompt.beadId,
    })
  }

  return activities
}

export function deriveCurrentActivity(entries: LogEntry[], nowMs = Date.now()): CurrentActivity | null {
  const activities = deriveCurrentActivities(entries, nowMs)
  if (activities.length === 0) return null
  return activities[activities.length - 1] || null
}
