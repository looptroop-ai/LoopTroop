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

interface PromptState {
  prompt: LogEntry
  startedAtMs: number
  questionGeneration: number
  hasFirstActivity: boolean
  retrying: boolean
  ended: boolean
  successful: boolean
  diagnostic?: { kind: CurrentActivityDiagnostic; timeMs: number }
}

type AnalyzedActivity =
  | { activity: CurrentActivity }
  | { state: PromptState; deadlineWasSuspended: boolean }

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
  if (entry.kind === 'milestone' && isStatusEntry(entry) && /^(?:\[SYS\]\s*)?First AI activity observed\b/i.test(entry.line)) return true
  return entry.audience === 'ai' && FIRST_ACTIVITY_KINDS.has(entry.kind)
}

function isProviderRetryEntry(entry: LogEntry): boolean {
  return isStatusEntry(entry)
    && /^(?:\[(?:SYS|ERROR)\]\s*)?Session (?:retry\b|status:\s*retry\b)/i.test(entry.line)
}

function isCommandEntry(entry: LogEntry): boolean {
  return entry.audience !== 'ai' && /^\[CMD\]/.test(entry.line.trimStart())
}

function isStatusEntry(entry: LogEntry): boolean {
  return !isCommandEntry(entry) && ['milestone', 'session', 'error'].includes(entry.kind)
    && (TRUSTED_DIAGNOSTIC_SOURCES.has(entry.source) || entry.source.startsWith('model:'))
}

function isTrustedDiagnosticEntry(entry: LogEntry): boolean {
  if (isCommandEntry(entry)) return false
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
  return entry.kind === 'milestone' && entry.source === 'system' && isTrustedDiagnosticEntry(entry)
    && /^(?:\[SYS\]\s*)?OpenCode\b.+\bsession=\S+,\s*messages=\d+,\s*responseChars=\d+\b/i.test(entry.line)
}

function isPromptCompletionEntry(entry: LogEntry): boolean {
  if (!isStatusEntry(entry)) return false
  if (entry.kind === 'session' && /^(?:\[SYS\]\s*)?Session status:\s*idle\b/i.test(entry.line)) return true
  if (entry.kind === 'milestone' && /^(?:\[SYS\]\s*)?AI session completed\b/i.test(entry.line)) return true
  return isPromptResultEntry(entry)
}

function isPromptFailureEntry(entry: LogEntry): boolean {
  return isStatusEntry(entry) && !isProviderRetryEntry(entry) && (
    (entry.kind === 'milestone' && /^(?:\[SYS\]\s*)?AI session failed\b/i.test(entry.line))
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
        label: 'Model returned no response text',
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

function laneKey(prompt: LogEntry): string {
  return JSON.stringify([getModelId(prompt) ?? null, prompt.beadId ?? null])
}

function addToIndex(index: Map<string, Set<PromptState>>, key: string | undefined, state: PromptState) {
  if (key === undefined) return
  let states = index.get(key)
  if (!states) index.set(key, states = new Set())
  states.add(state)
}

function removeFromIndex(index: Map<string, Set<PromptState>>, key: string | undefined, state: PromptState) {
  if (key === undefined) return
  const states = index.get(key)
  states?.delete(state)
  if (states?.size === 0) index.delete(key)
}

export function analyzeCurrentActivities(
  entries: LogEntry[],
  options: CurrentActivityOptions = {},
): AnalyzedActivity[] {
  let activeStatus = options.activeStatus ?? undefined
  if (!activeStatus) {
    let latest: IndexedEntry | undefined
    for (const [index, entry] of entries.entries()) {
      if (!entry.status || entry.status === 'BLOCKED_ERROR') continue
      const candidate = { entry, index, timeMs: parseTimeMs(entry.timestamp) }
      if (!latest || compareIndexedEntries(candidate, latest) > 0) latest = candidate
    }
    activeStatus = latest?.entry.status
  }
  const phaseEntries = entries.filter(entry => !activeStatus || entry.status === activeStatus)
  const activePhaseAttempt = options.activePhaseAttempt
    ?? phaseEntries.reduce((latest, entry) => Math.max(latest, entry.phaseAttempt ?? 1), 1)
  const orderedEntries = sortEntries(phaseEntries.filter(entry => (entry.phaseAttempt ?? 1) === activePhaseAttempt))
  const states = new Set<PromptState>()
  const sessions = new Map<string, PromptState>()
  const models = new Map<string, Set<PromptState>>()
  const beads = new Map<string, Set<PromptState>>()
  const lanes = new Map<string, Set<PromptState>>()
  const endedLanes = new Map<string, Set<PromptState>>()
  const anonymousLanes = new Map<string, PromptState>()
  let questionGeneration = 0

  const retire = (state: PromptState) => {
    states.delete(state)
    if (state.prompt.sessionId) sessions.delete(state.prompt.sessionId)
    const key = laneKey(state.prompt)
    removeFromIndex(models, getModelId(state.prompt), state)
    removeFromIndex(beads, state.prompt.beadId, state)
    removeFromIndex(lanes, key, state)
    removeFromIndex(endedLanes, key, state)
    if (anonymousLanes.get(key) === state) anonymousLanes.delete(key)
  }
  const end = (state: PromptState) => {
    state.ended = true
    addToIndex(endedLanes, laneKey(state.prompt), state)
  }

  for (const { entry, timeMs } of orderedEntries) {
    if (isCommandEntry(entry)) continue
    if (isPromptEntry(entry)) {
      const key = laneKey(entry)
      const previous = entry.sessionId ? sessions.get(entry.sessionId) : anonymousLanes.get(key)
      if (previous) retire(previous)
      // An ended turn can be replaced; overlapping sessions in the same lane stay independent.
      for (const ended of endedLanes.get(key) ?? []) retire(ended)
      const state: PromptState = {
        prompt: entry, startedAtMs: timeMs, questionGeneration,
        hasFirstActivity: false, retrying: false, ended: false, successful: false,
      }
      states.add(state)
      if (entry.sessionId) sessions.set(entry.sessionId, state)
      else anonymousLanes.set(key, state)
      addToIndex(models, getModelId(entry), state)
      addToIndex(beads, entry.beadId, state)
      addToIndex(lanes, key, state)
      continue
    }
    if (isStatusEntry(entry) && entry.kind === 'session' && /^\[QUESTION\]/.test(entry.line)) questionGeneration++

    const sessionId = getSessionId(entry)
    const modelId = getModelId(entry)
    const beadId = getBeadId(entry)
    let state: PromptState | undefined
    if (sessionId) state = sessions.get(sessionId)
    else {
      const candidates = modelId && beadId
        ? lanes.get(JSON.stringify([modelId, beadId]))
        : modelId ? models.get(modelId) : beadId ? beads.get(beadId) : states
      if (candidates?.size === 1) state = candidates.values().next().value
    }
    if (!state) continue
    if (state.successful && !sessionId && !beadId) continue

    const firstActivity = isFirstActivityEntry(entry)
    let diagnostic: CurrentActivityDiagnostic | undefined
    if (isProviderRetryTimeoutEntry(entry)) diagnostic = 'provider_retry_timeout'
    else if (isProviderTimeoutPreservedEntry(entry)) diagnostic = 'provider_timeout_preserved'
    else if (isEmptyModelOutputEntry(entry)) diagnostic = 'empty_model_output'
    else if (isIterationTimeoutEntry(entry)) diagnostic = 'iteration_timeout'
    else if (isTrustedPromptTimeoutEntry(entry)
      || (isStatusEntry(entry) && entry.entryId.endsWith(':draft-finished') && /\bdraft timed out\b/i.test(entry.line))) {
      diagnostic = state.hasFirstActivity ? 'workflow_timeout' : 'model_no_activity_timeout'
    }
    if (diagnostic) {
      state.diagnostic = { kind: diagnostic, timeMs }
      end(state)
    }
    if (isPromptResultEntry(entry) && !isEmptyModelOutputEntry(entry)) {
      state.successful = true
      state.diagnostic = undefined
    }
    if (isProviderRetryEntry(entry)) state.retrying = true
    else if (firstActivity || (isStatusEntry(entry) && /^(?:\[SYS\]\s*)?Session status:\s*busy\b/i.test(entry.line))) state.retrying = false
    if (firstActivity) state.hasFirstActivity = true
    const reset = isTrustedDiagnosticEntry(entry)
      && /^(?:\[SYS\]\s*)?Reset bead \S+ to its start snapshot\b/i.test(entry.line)
    if (isPromptCompletionEntry(entry) || isPromptFailureEntry(entry) || reset) end(state)
  }

  const analysis: AnalyzedActivity[] = []
  for (const state of states) {
    if (state.diagnostic) analysis.push({ activity: buildDiagnosticActivity(state.diagnostic.kind, state.prompt, state.diagnostic.timeMs) })
    else if (!state.ended && (!state.hasFirstActivity || state.retrying)) {
      analysis.push({ state, deadlineWasSuspended: state.questionGeneration !== questionGeneration })
    }
  }
  return analysis
}

export function resolveCurrentActivities(
  analysis: AnalyzedActivity[],
  nowMs = Date.now(),
  options: Pick<CurrentActivityOptions, 'suppressNearTimeout'> = {},
): CurrentActivity[] {
  return analysis.map(item => {
    if ('activity' in item) return item.activity
    const { state, deadlineWasSuspended } = item
    const prompt = state.prompt
    if (!options.suppressNearTimeout && !deadlineWasSuspended && isNearTimeoutPrompt(prompt, nowMs)) {
      const activity = buildDiagnosticActivity('near_timeout', prompt, nowMs)
      if (nowMs >= parseDeadlineMs(prompt.deadlineAt)) activity.label = 'Prompt deadline reached; awaiting outcome'
      return activity
    }
    return {
      kind: state.retrying ? 'provider_retrying' : 'waiting_first_model_activity',
      active: true,
      severity: state.retrying ? 'warning' : 'info',
      label: state.retrying
        ? state.hasFirstActivity ? 'Provider retrying' : 'Provider retrying before first model activity'
        : 'Waiting for first model activity',
      elapsedMs: Number.isFinite(state.startedAtMs) ? Math.max(0, nowMs - state.startedAtMs) : undefined,
      modelId: getModelId(prompt), sessionId: prompt.sessionId, beadId: prompt.beadId,
    }
  })
}

export function deriveCurrentActivities(
  entries: LogEntry[], nowMs = Date.now(), options: CurrentActivityOptions = {},
): CurrentActivity[] {
  return resolveCurrentActivities(analyzeCurrentActivities(entries, options), nowMs, options)
}

export function deriveCurrentActivity(entries: LogEntry[], nowMs = Date.now()): CurrentActivity | null {
  return deriveCurrentActivities(entries, nowMs).at(-1) ?? null
}
