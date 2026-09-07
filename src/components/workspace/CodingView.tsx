import { useMemo, useState, useRef, useEffect, useCallback } from 'react'
import { useLogs } from '@/context/useLogContext'
import { getLogEntryIdentity, mergeEntriesBatch, type LogEntry } from '@/context/logUtils'
import { useQuery } from '@tanstack/react-query'
import { QUERY_STALE_TIME_5M, QUERY_STALE_TIME_5S, COPY_SUCCESS_DISPLAY_SHORT_MS } from '@/lib/constants'
import { Loader2, CheckCircle2, Circle, Play, Eye, FileCode2, List, Brain, Clock, GitCommit, Tag, Link2, ArrowRight, ArrowUpToLine, ArrowDownToLine, Copy, Check, FileInput, FileOutput } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PhaseArtifactsPanel } from './PhaseArtifactsPanel'
import { CollapsiblePhaseLogSection } from './CollapsiblePhaseLogSection'
import { PhaseAttemptSelector, PhaseAttemptsUnavailable } from './PhaseAttemptSelector'
import { selectedAttemptNumber } from './phaseAttemptSelection'
import { useSelectedPhaseAttempt } from './useSelectedPhaseAttempt'
import { BeadDiffViewer } from './BeadDiffViewer'
import { renderCommandSpec, type CommandSpec } from '@shared/commandSpec'
import { LogEntryRow } from './LogLine'
import { filterBeadLogEntries, formatLogLine } from './logFormat'
import { LogColorLegend } from './LogColorLegend'
import { VerificationSummaryPanel } from './VerificationSummaryPanel'
import { formatElapsedDuration } from './currentActivity'
import type { BeadNoteEntry, Ticket } from '@/hooks/useTickets'
import { useTicketAction } from '@/hooks/useTickets'
import { useTicketArtifacts } from '@/hooks/useTicketArtifacts'
import { useTicketHistoricalLogs } from '@/hooks/useTicketHistoricalLogs'
import { cn } from '@/lib/utils'
import { getStatusUserLabel } from '@/lib/workflowMeta'
import { parsePrdDocument, parsePrdDocumentContent, normalizePrdDocumentLike } from '@/lib/prdDocument'
import type { PrdDocument } from '@/lib/prdDocument'
import { isStatusAtOrPast } from '@shared/workflowMeta'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { buildReadableRawDisplayContent } from './rawDisplayContent'
import { CopyButton as RawCopyButton, RawDisplayPre, RawDisplayStats } from './RawTextDisplay'
import { manualQaEvidenceUrl } from '@/hooks/useManualQA'
import { normalizeRawAttempts, tryParseStructuredContent, type ArtifactRawAttemptData } from './phaseArtifactTypes'
import { stripAnsiSequences } from '@shared/ansi'
import { apiFilePath, apiTicketPath } from '@/lib/apiPaths'
import { throwIfNotOk } from '@/lib/fetchError'
import { QueryErrorNotice } from '@/components/shared/QueryErrorNotice'

interface CodingViewProps {
  ticket: Ticket
  readOnly?: boolean
}

interface TicketBead {
  id: string
  title: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
  iteration: number
  priority: number
  issueType: string
  externalRef: string
  labels: string[]
  prdRefs: string[]
  acceptanceCriteria: string[]
  tests: string[]
  testCommands: CommandSpec[]
  testCommandReason?: string
  targetFiles: string[]
  contextGuidance: { patterns: string[]; anti_patterns: string[] }
  dependencies: { blocked_by: string[]; blocks: string[] }
  failedIterationNotes: BeadNoteEntry[]
  userRetryNotes: BeadNoteEntry[]
  finalizationFailureNotes: BeadNoteEntry[]
  createdAt: string
  updatedAt: string
  completedAt: string
  startedAt: string
  beadStartCommit: string | null
  qaOrigin?: {
    schemaVersion?: 1
    actionId?: string
    version: number
    sourceTicketId?: string
    sourceTicketExternalId?: string
    sourceItems: Array<{
      itemId: string
      lineageId?: string
      title?: string
      behavior?: string
      observation: string
      expectedResult: string
      evidence?: Array<{ id?: string; name?: string; originalName?: string; url?: string; mediaType?: string; mimeType?: string; previewable?: boolean; inlinePreview?: boolean } | string>
      evidenceRefs?: Array<{ id?: string; name?: string; url?: string; mediaType?: string; previewable?: boolean } | string>
      links?: Array<{ id?: string; url: string; label?: string }>
    }>
  } | null
}

function resolveCodingReviewStatus(ticket: Pick<Ticket, 'status' | 'previousStatus' | 'reviewCutoffStatus'>): string | null {
  if (ticket.status === 'BLOCKED_ERROR') {
    return ticket.previousStatus ?? ticket.reviewCutoffStatus ?? null
  }

  if (ticket.status === 'CANCELED') {
    if (ticket.reviewCutoffStatus) return ticket.reviewCutoffStatus
    return ticket.previousStatus && ticket.previousStatus !== 'BLOCKED_ERROR'
      ? ticket.previousStatus
      : null
  }

  return ticket.status
}

function shouldShowCompletedCodingState(
  ticket: Pick<Ticket, 'status' | 'previousStatus' | 'reviewCutoffStatus'>,
  readOnly?: boolean,
): boolean {
  if (ticket.status === 'COMPLETED') return true
  if (!readOnly) return false

  const reviewStatus = resolveCodingReviewStatus(ticket)
  return reviewStatus ? isStatusAtOrPast(reviewStatus, 'RUNNING_FINAL_TEST') : false
}

function normalizeNoteEntries(input: unknown, stripAnsi = true): BeadNoteEntry[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const entry = item as Record<string, unknown>
    if (typeof entry.content !== 'string' || !entry.content.trim()) return []
    const content = stripAnsi ? stripAnsiSequences(entry.content) : entry.content
    return [{
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
      iteration: typeof entry.iteration === 'number' && Number.isFinite(entry.iteration) ? entry.iteration : 0,
      content,
      ...(typeof entry.errorCode === 'string' ? { errorCode: entry.errorCode } : {}),
    }]
  })
}

function formatTimestamp(iso: string): React.ReactNode {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    
    const timeString = d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    
    const ms = d.getMilliseconds().toString().padStart(3, '0')
    
    return (
      <>
        {timeString}.<span className="opacity-40">{ms}</span>
      </>
    )
  } catch {
    return iso
  }
}

function relativeTime(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    const diff = Date.now() - d.getTime()
    const secs = Math.floor(diff / 1000)
    if (secs < 60) return `${secs}s ago`
    const mins = Math.floor(secs / 60)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    const days = Math.floor(hrs / 24)
    return `${days}d ago`
  } catch {
    return ''
  }
}

function BeadNoteHistory({
  title,
  notes,
  tone,
}: {
  title: string
  notes: BeadNoteEntry[]
  tone: 'rose' | 'amber' | 'violet'
}) {
  if (notes.length === 0) return null
  const colors = {
    rose: 'border-rose-300 dark:border-rose-700 text-rose-600 dark:text-rose-400',
    amber: 'border-amber-300 dark:border-amber-700 text-amber-600 dark:text-amber-400',
    violet: 'border-violet-300 dark:border-violet-700 text-violet-600 dark:text-violet-400',
  }[tone]
  return (
    <div className={cn('border-l-2 pl-2', colors)}>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest">{title}</div>
      <div className="space-y-2 text-xs text-foreground">
        {notes.map((note, index) => (
          <div key={`${note.timestamp}-${note.iteration}-${index}`} className="rounded border border-border/50 bg-muted/50 px-2 py-1.5">
            <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground/70">
              {note.iteration > 0 ? <Badge variant="outline" className="px-1 py-0 text-[9px]">Iteration {note.iteration}</Badge> : null}
              {note.timestamp ? (
                <Tooltip>
                  <TooltipTrigger asChild><span>{formatTimestamp(note.timestamp)}</span></TooltipTrigger>
                  <TooltipContent className="max-w-xs text-center text-balance">{note.timestamp}</TooltipContent>
                </Tooltip>
              ) : null}
              {note.errorCode ? <code className="font-mono">{note.errorCode}</code> : null}
            </div>
            <div className="whitespace-pre-wrap">{note.content}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function normalizeBead(input: {
  id: string
  title: string
  status: string
  iteration: number
  description?: string
  priority?: number
  issueType?: string
  externalRef?: string
  labels?: string[]
  prdRefs?: string[]
  acceptanceCriteria?: string[]
  tests?: string[]
  testCommands?: CommandSpec[]
  testCommandReason?: string
  targetFiles?: string[]
  contextGuidance?: { patterns?: string[]; anti_patterns?: string[] }
  dependencies?: { blocked_by?: string[]; blocks?: string[] }
  failedIterationNotes?: BeadNoteEntry[]
  userRetryNotes?: BeadNoteEntry[]
  finalizationFailureNotes?: BeadNoteEntry[]
  createdAt?: string
  updatedAt?: string | null
  completedAt?: string | null
  startedAt?: string | null
  beadStartCommit?: string | null
  qaOrigin?: TicketBead['qaOrigin']
}): TicketBead {
  const STATUS_MAP: Record<string, TicketBead['status']> = {
    done: 'completed',
    error: 'failed',
  }
  const allowedStatuses: TicketBead['status'][] = ['pending', 'in_progress', 'completed', 'failed', 'skipped']
  const mappedStatus = STATUS_MAP[input.status] ?? input.status
  const status = allowedStatuses.includes(mappedStatus as TicketBead['status'])
    ? mappedStatus as TicketBead['status']
    : 'pending'

  const cg = input.contextGuidance
  const contextGuidance = cg && typeof cg === 'object' && !Array.isArray(cg)
    ? { patterns: Array.isArray(cg.patterns) ? cg.patterns : [], anti_patterns: Array.isArray(cg.anti_patterns) ? cg.anti_patterns : [] }
    : { patterns: [], anti_patterns: [] }

  const deps = input.dependencies
  const dependencies = deps && typeof deps === 'object' && !Array.isArray(deps)
    ? { blocked_by: Array.isArray(deps.blocked_by) ? deps.blocked_by : [], blocks: Array.isArray(deps.blocks) ? deps.blocks : [] }
    : { blocked_by: [], blocks: [] }

  return {
    id: input.id,
    title: input.title,
    description: input.description ?? '',
    status,
    iteration: input.iteration ?? 0,
    priority: input.priority ?? 0,
    issueType: input.issueType ?? '',
    externalRef: input.externalRef ?? '',
    labels: Array.isArray(input.labels) ? input.labels : [],
    prdRefs: Array.isArray(input.prdRefs) ? input.prdRefs : [],
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    tests: input.tests ?? [],
    testCommands: input.testCommands ?? [],
    ...(input.testCommandReason ? { testCommandReason: input.testCommandReason } : {}),
    targetFiles: Array.isArray(input.targetFiles) ? input.targetFiles : [],
    contextGuidance,
    dependencies,
    failedIterationNotes: normalizeNoteEntries(input.failedIterationNotes),
    userRetryNotes: normalizeNoteEntries(input.userRetryNotes, false),
    finalizationFailureNotes: normalizeNoteEntries(input.finalizationFailureNotes),
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : '',
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : '',
    completedAt: typeof input.completedAt === 'string' ? input.completedAt : '',
    startedAt: typeof input.startedAt === 'string' ? input.startedAt : '',
    beadStartCommit: input.beadStartCommit ?? null,
    qaOrigin: input.qaOrigin ?? null,
  }
}

function mergeBeadRuntimeOverlay(
  beads: TicketBead[],
  runtimeBeads: Ticket['runtime']['beads'] | undefined,
): TicketBead[] {
  if (!Array.isArray(runtimeBeads) || runtimeBeads.length === 0) return beads

  const runtimeById = new Map(
    runtimeBeads
      .filter((bead): bead is NonNullable<Ticket['runtime']['beads']>[number] =>
        Boolean(bead && typeof bead.id === 'string' && bead.id.length > 0),
      )
      .map((bead) => [bead.id, normalizeBead(bead)]),
  )

  const seen = new Set<string>()
  const merged = beads.map((bead) => {
    const runtimeBead = runtimeById.get(bead.id)
    if (!runtimeBead) return bead
    seen.add(bead.id)

    if (
      bead.title === runtimeBead.title
      && bead.status === runtimeBead.status
      && bead.iteration === runtimeBead.iteration
      && bead.failedIterationNotes === runtimeBead.failedIterationNotes
      && bead.userRetryNotes === runtimeBead.userRetryNotes
      && bead.finalizationFailureNotes === runtimeBead.finalizationFailureNotes
    ) {
      return bead
    }

    return {
      ...bead,
      title: runtimeBead.title || bead.title,
      status: runtimeBead.status,
      iteration: runtimeBead.iteration,
      failedIterationNotes: runtimeBead.failedIterationNotes,
      userRetryNotes: runtimeBead.userRetryNotes,
      finalizationFailureNotes: runtimeBead.finalizationFailureNotes,
    }
  })

  for (const runtimeBead of runtimeById.values()) {
    if (seen.has(runtimeBead.id)) continue
    merged.push(runtimeBead)
  }

  return merged
}

async function fetchTicketBeads(ticketId: string, signal?: AbortSignal): Promise<TicketBead[]> {
  const response = await fetch(apiTicketPath(ticketId, 'beads'), { signal })
  await throwIfNotOk(response, 'Failed to load beads')
  const payload = await response.json()
  return Array.isArray(payload)
    ? payload
        .filter((item): item is {
          id: string
          title: string
          status: string
          iteration: number
          description?: string
          priority?: number
          issueType?: string
          externalRef?: string
          labels?: string[]
          prdRefs?: string[]
          acceptanceCriteria?: string[]
          tests?: string[]
          testCommands?: CommandSpec[]
          testCommandReason?: string
          targetFiles?: string[]
          contextGuidance?: { patterns?: string[]; anti_patterns?: string[] }
          dependencies?: { blocked_by?: string[]; blocks?: string[] }
          failedIterationNotes?: BeadNoteEntry[]
          userRetryNotes?: BeadNoteEntry[]
          finalizationFailureNotes?: BeadNoteEntry[]
          createdAt?: string
          updatedAt?: string | null
          completedAt?: string
          startedAt?: string | null
          beadStartCommit?: string | null
          qaOrigin?: TicketBead['qaOrigin']
        } =>
          Boolean(item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' && typeof (item as { title?: unknown }).title === 'string'),
        )
        .map((item) => normalizeBead(item))
    : []
}

function statusIcon(status: TicketBead['status']) {
  switch (status) {
    case 'completed':
    case 'skipped':
      return <CheckCircle2 className="h-3 w-3 text-green-600" />
    case 'in_progress':
      return <Play className="h-3 w-3 text-primary fill-primary" />
    default:
      return <Circle className="h-3 w-3 text-muted-foreground" />
  }
}

const COMPACT_THRESHOLD = 15
type BeadDetailTab = 'details' | 'changes' | 'model' | 'input' | 'output'

interface BeadRawAttempt {
  attempt: number
  iteration: number
  initialInput: string
  rawResponse?: string
  modelOutput?: string
  content?: string
  error?: string
  validationError?: string
  failureClass?: string
  status?: string
  outcome?: string
  modelId?: string
  sessionId?: string
  source: 'artifact' | 'log' | 'merged'
  terminal: boolean
}

const TERMINAL_BEAD_STATUSES = new Set<TicketBead['status']>(['completed', 'failed', 'skipped'])
const TERMINAL_RAW_OUTCOMES = new Set(['accepted', 'rejected', 'failed', 'timed_out', 'timed-out', 'timeout', 'cancelled', 'canceled', 'error', 'invalid_output'])

const BEAD_TAB_TOOLTIPS: Record<BeadDetailTab, string> = {
  details: 'Bead metadata, requirements, dependencies, and notes.',
  changes: 'Captured code diff for this bead. Available after the bead is done or skipped.',
  model: 'Bead-scoped execution transcript.',
  input: 'Raw initial prompt sent for the selected bead iteration.',
  output: 'Final model response or diagnostic for the selected bead iteration.',
}

function normalizeRawAttemptNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function getRawAttemptKey(attempt: Pick<BeadRawAttempt, 'iteration' | 'attempt'>): number {
  return attempt.iteration > 0 ? attempt.iteration : attempt.attempt
}

function getRawAttemptOutcome(attempt: Pick<BeadRawAttempt, 'outcome' | 'status'>): string {
  return (attempt.outcome || attempt.status || '').trim().toLowerCase()
}

function formatRawAttemptOutcome(attempt: Pick<BeadRawAttempt, 'outcome' | 'status'>): string {
  const outcome = getRawAttemptOutcome(attempt)
  if (!outcome) return 'In progress'
  if (outcome === 'timed_out' || outcome === 'timed-out' || outcome === 'timeout') return 'Timed out'
  if (outcome === 'invalid_output') return 'Rejected'
  return outcome
    .split(/[_\s-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function stripPromptLogHeader(line: string): string {
  const trimmed = line.trimStart()
  if (!trimmed.startsWith('[PROMPT]')) return line
  const newlineIndex = trimmed.indexOf('\n')
  return newlineIndex >= 0 ? trimmed.slice(newlineIndex + 1) : ''
}

function stripOutputLogTag(line: string): string {
  return line.replace(/^\s*\[(?:MODEL|ERROR)\]\s*/i, '')
}

function buildAttemptDiagnostic(attempt: Pick<BeadRawAttempt, 'error' | 'validationError' | 'failureClass'>): string {
  const sections: string[] = []
  if (attempt.validationError?.trim()) {
    sections.push(['Validation error:', attempt.validationError.trim()].join('\n'))
  }
  if (attempt.error?.trim()) {
    sections.push(['Error:', attempt.error.trim()].join('\n'))
  }
  if (attempt.failureClass?.trim()) {
    sections.push(`Failure class: ${attempt.failureClass.trim()}`)
  }
  return sections.join('\n\n')
}

function getRawAttemptInput(attempt: BeadRawAttempt | null | undefined): string {
  return attempt?.initialInput?.trimEnd() ?? ''
}

function getRawAttemptOutput(attempt: BeadRawAttempt | null | undefined): string {
  if (!attempt) return ''
  const modelText = attempt.rawResponse ?? attempt.modelOutput ?? attempt.content ?? ''
  if (modelText.trim()) return modelText.trimEnd()
  return buildAttemptDiagnostic(attempt)
}

function isRawAttemptTerminal(attempt: BeadRawAttempt | null | undefined, bead: TicketBead | null): boolean {
  if (!attempt) return false
  if (attempt.terminal) return true
  const outcome = getRawAttemptOutcome(attempt)
  if (TERMINAL_RAW_OUTCOMES.has(outcome)) return true
  if (bead && attempt.iteration > 0 && bead.iteration > attempt.iteration) return true
  return bead ? TERMINAL_BEAD_STATUSES.has(bead.status) : false
}

function normalizeArtifactAttempt(entry: ArtifactRawAttemptData, index: number): BeadRawAttempt {
  const fallback = index + 1
  const iteration = normalizeRawAttemptNumber(entry.iteration ?? entry.attempt, fallback)
  const attempt = normalizeRawAttemptNumber(entry.attempt ?? entry.iteration, iteration)
  return {
    attempt,
    iteration,
    initialInput: entry.initialInput ?? '',
    rawResponse: entry.rawResponse,
    modelOutput: entry.modelOutput,
    content: entry.content,
    error: entry.error,
    validationError: entry.validationError,
    failureClass: entry.failureClass,
    status: entry.status,
    outcome: entry.outcome,
    modelId: entry.modelId,
    sessionId: entry.sessionId,
    source: 'artifact',
    terminal: true,
  }
}

function parseBeadExecutionAttempts(
  artifacts: Array<{ artifactType: string; content: string | null }>,
  beadId: string,
): BeadRawAttempt[] {
  const artifact = artifacts.find((entry) => entry.artifactType === `bead_execution:${beadId}`)
  if (!artifact?.content) return []

  const parsed = tryParseStructuredContent(artifact.content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const record = parsed as Record<string, unknown>
  const rawAttemptsValue = record.rawAttempts ?? record.raw_attempts
  const attempts = normalizeRawAttempts(rawAttemptsValue)
  if (attempts?.length) {
    return attempts.map(normalizeArtifactAttempt)
  }

  const iteration = normalizeRawAttemptNumber(record.iteration, 1)
  const output = typeof record.output === 'string' ? record.output : ''
  const errors = Array.isArray(record.errors)
    ? record.errors.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
  const diagnostics = record.diagnostics && typeof record.diagnostics === 'object'
    ? JSON.stringify(record.diagnostics, null, 2)
    : ''
  if (!output.trim() && errors.length === 0 && !diagnostics) return []
  const outcome = record.success === true ? 'accepted' : 'failed'
  return [{
    attempt: iteration,
    iteration,
    status: outcome,
    outcome,
    initialInput: '',
    ...(output ? { rawResponse: output, modelOutput: output } : {}),
    ...(errors.length > 0 ? { error: errors.join('\n') } : diagnostics ? { error: diagnostics } : {}),
    source: 'artifact',
    terminal: true,
  }]
}

function buildLogDerivedRawAttempts(entries: LogEntry[], fallbackIteration: number): BeadRawAttempt[] {
  const byIteration = new Map<number, BeadRawAttempt>()
  const ensureAttempt = (iteration: number) => {
    const existing = byIteration.get(iteration)
    if (existing) return existing
    const created: BeadRawAttempt = {
      attempt: iteration,
      iteration,
      initialInput: '',
      source: 'log',
      terminal: false,
    }
    byIteration.set(iteration, created)
    return created
  }

  for (const entry of entries) {
    const iteration = normalizeRawAttemptNumber(entry.beadIteration, fallbackIteration)
    const attempt = ensureAttempt(iteration)
    if (entry.modelId && !attempt.modelId) attempt.modelId = entry.modelId
    if (entry.sessionId && !attempt.sessionId) attempt.sessionId = entry.sessionId

    if (entry.kind === 'prompt') {
      const promptBody = stripPromptLogHeader(entry.line).trimEnd()
      if (promptBody && !attempt.initialInput) {
        attempt.initialInput = promptBody
      }
      continue
    }

    if ((entry.kind === 'text' || entry.kind === 'error') && !entry.streaming && entry.op !== 'upsert') {
      const output = stripOutputLogTag(entry.line).trimEnd()
      if (output) {
        if (entry.kind === 'error') {
          attempt.error = output
          attempt.status = attempt.status ?? 'failed'
          attempt.outcome = attempt.outcome ?? 'failed'
        } else {
          attempt.rawResponse = output
          attempt.modelOutput = output
        }
      }
    }
  }

  return Array.from(byIteration.values())
}

const CODING_SESSION_START_PATTERN = /Coding session created for bead\s+.+?\s+attempt\s+(\d+)\s+\(session=/i

function getIterationLogBounds(entries: LogEntry[], iteration: number): { start: number; end: number } | null {
  const start = entries.findIndex((entry) => Number(entry.line.match(CODING_SESSION_START_PATTERN)?.[1]) === iteration)
  if (start < 0) return null

  const endOffset = entries
    .slice(start + 1)
    .findIndex((entry) => Number(entry.line.match(CODING_SESSION_START_PATTERN)?.[1]) > iteration)

  return {
    start,
    end: endOffset < 0 ? entries.length : start + 1 + endOffset,
  }
}

function mergeRawAttempts(persisted: BeadRawAttempt[], logDerived: BeadRawAttempt[]): BeadRawAttempt[] {
  const byIteration = new Map<number, BeadRawAttempt>()

  for (const attempt of logDerived) {
    byIteration.set(getRawAttemptKey(attempt), attempt)
  }

  for (const attempt of persisted) {
    const key = getRawAttemptKey(attempt)
    const existing = byIteration.get(key)
    byIteration.set(key, {
      ...(existing ?? attempt),
      ...attempt,
      initialInput: attempt.initialInput || existing?.initialInput || '',
      rawResponse: attempt.rawResponse || existing?.rawResponse,
      modelOutput: attempt.modelOutput || existing?.modelOutput,
      content: attempt.content || existing?.content,
      error: attempt.error || existing?.error,
      validationError: attempt.validationError || existing?.validationError,
      failureClass: attempt.failureClass || existing?.failureClass,
      modelId: attempt.modelId || existing?.modelId,
      sessionId: attempt.sessionId || existing?.sessionId,
      source: existing ? 'merged' : attempt.source,
      terminal: true,
    })
  }

  return Array.from(byIteration.values())
    .filter((attempt) => getRawAttemptInput(attempt).trim() || getRawAttemptOutput(attempt).trim())
    .sort((left, right) => getRawAttemptKey(left) - getRawAttemptKey(right))
}

function selectDefaultRawAttemptKey(attempts: BeadRawAttempt[], bead: TicketBead | null): number | null {
  const sorted = [...attempts].sort((left, right) => getRawAttemptKey(right) - getRawAttemptKey(left))
  const currentRunningInput = bead?.status === 'in_progress'
    ? sorted.find((attempt) =>
        attempt.iteration === bead.iteration
        && getRawAttemptInput(attempt).trim()
        && !getRawAttemptOutput(attempt).trim())
    : undefined
  if (currentRunningInput) return getRawAttemptKey(currentRunningInput)
  const meaningfulOutput = sorted.find((attempt) => getRawAttemptOutput(attempt).trim() && isRawAttemptTerminal(attempt, bead))
  if (meaningfulOutput) return getRawAttemptKey(meaningfulOutput)
  const inputAttempt = sorted.find((attempt) => getRawAttemptInput(attempt).trim())
  if (inputAttempt) return getRawAttemptKey(inputAttempt)
  return sorted[0] ? getRawAttemptKey(sorted[0]) : null
}

function usePrdDocument(ticketId: string): { prd: PrdDocument | null; isLoading: boolean; isError: boolean } {
  const { data: fetchedContent, isLoading, isError } = useQuery({
    queryKey: ['artifact', ticketId, 'prd'],
    queryFn: async ({ signal }) => {
      const response = await fetch(apiFilePath(ticketId, 'prd'), { signal })
      await throwIfNotOk(response, 'Failed to load PRD')
      const payload = await response.json() as { content?: string }
      return payload.content ?? ''
    },
    staleTime: QUERY_STALE_TIME_5M,
  })
  const prd = useMemo(
    () => fetchedContent ? normalizePrdDocumentLike(parsePrdDocument(fetchedContent) ?? parsePrdDocumentContent(fetchedContent).document) : null,
    [fetchedContent],
  )
  return { prd, isLoading, isError }
}

function lookupPrdRef(prd: PrdDocument | null, ref: string): { type: 'epic'; title: string; objective: string } | { type: 'story'; title: string; epicTitle: string; acceptanceCriteria: string[] } | null {
  if (!prd) return null
  // Extract embedded IDs from composite refs like "EPIC-1 / US-1.1"
  const ids = ref.match(/\b(?:EPIC|US)-[A-Za-z0-9.-]+\b/gi) ?? [ref]
  for (const id of ids) {
    for (const epic of prd.epics) {
      if (epic.id === id) {
        return { type: 'epic', title: epic.title, objective: epic.objective }
      }
      for (const story of epic.user_stories) {
        if (story.id === id) {
          return { type: 'story', title: story.title, epicTitle: epic.title, acceptanceCriteria: story.acceptance_criteria }
        }
      }
    }
  }
  return null
}

function PrdRefHoverCard({ refId, prd, isLoading, isError }: { refId: string; prd: PrdDocument | null; isLoading: boolean; isError: boolean }) {
  const match = lookupPrdRef(prd, refId)

  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <code className="text-[10px] bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 px-1.5 py-0.5 rounded font-mono cursor-help">{refId}</code>
      </HoverCardTrigger>
      <HoverCardContent side="top" className="w-72">
        {match ? (
          match.type === 'epic' ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Badge variant="outline" className="text-[10px] h-4 px-1.5 shrink-0">Epic</Badge>
                <span className="text-xs font-medium truncate">{match.title}</span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug">{match.objective}</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Badge variant="outline" className="text-[10px] h-4 px-1.5 shrink-0">Story</Badge>
                <span className="text-xs font-medium truncate">{match.title}</span>
              </div>
              <div className="text-[10px] text-muted-foreground">Epic: {match.epicTitle}</div>
              {match.acceptanceCriteria.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold text-muted-foreground mb-0.5">Acceptance Criteria</div>
                  <ul className="text-[11px] space-y-0.5 pl-2 max-h-[200px] overflow-y-auto">
                    {match.acceptanceCriteria.map((ac, i) => (
                      <li key={i} className="text-muted-foreground leading-snug">- {ac}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )
        ) : (
          <div className="text-xs text-muted-foreground italic">
            {isLoading ? 'Loading PRD…' : isError ? 'PRD unavailable' : prd ? 'Reference not found in PRD' : 'PRD not loaded'}
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}

function LabelHoverCard({ label, beads, currentBeadId, onSelectBead }: {
  label: string
  beads: TicketBead[]
  currentBeadId: string
  onSelectBead: (id: string) => void
}) {
  const matching = useMemo(
    () => beads.filter((b) => b.id !== currentBeadId && b.labels.includes(label)),
    [beads, label, currentBeadId],
  )

  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span className="inline-flex cursor-help">
          <Badge variant="outline" className="text-[10px] h-4 px-1.5">{label}</Badge>
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="top" className="w-72">
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Beads with "{label}"
          </div>
          {matching.length > 0 ? (
            <div className="space-y-1 max-h-[200px] overflow-y-auto">
              {matching.map((bead) => {
                const beadIndex = beads.findIndex((b) => b.id === bead.id)
                return (
                  <button
                    key={bead.id}
                    type="button"
                    onClick={() => onSelectBead(bead.id)}
                    className="w-full text-left rounded-md border border-border/70 bg-background px-2 py-1 transition-colors hover:bg-accent/30"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      {statusIcon(bead.status)}
                      <span className="text-[11px] truncate flex-1">
                        {bead.title}{beadIndex !== -1 ? ` (#${beadIndex + 1})` : ''}
                      </span>
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[9px] h-3.5 px-1 shrink-0',
                          bead.status === 'completed' && 'border-green-600/40 text-green-700 dark:text-green-400',
                          bead.status === 'in_progress' && 'border-primary/40 text-primary',
                          bead.status === 'failed' && 'border-red-600/40 text-red-700 dark:text-red-400',
                        )}
                      >
                        {bead.status.replace('_', ' ')}
                      </Badge>
                    </div>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="text-[11px] text-muted-foreground italic">No other beads share this label.</div>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

function BeadRefHoverCard({ beadId, beads, onSelectBead }: {
  beadId: string
  beads: TicketBead[]
  onSelectBead: (id: string) => void
}) {
  const bead = useMemo(() => beads.find((b) => b.id === beadId), [beads, beadId])
  const beadIndex = useMemo(() => beads.findIndex((b) => b.id === beadId), [beads, beadId])

  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <code
          className="text-[10px] bg-orange-500/10 text-orange-700 dark:text-orange-300 px-1.5 py-0.5 rounded font-mono mr-1 cursor-help"
        >
          {beadId}{beadIndex !== -1 ? ` (#${beadIndex + 1})` : ''}
        </code>
      </HoverCardTrigger>
      <HoverCardContent side="top" className="w-72">
        {bead ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              {statusIcon(bead.status)}
              <span className="text-xs font-medium truncate flex-1">
                {bead.title}{beadIndex !== -1 ? ` (#${beadIndex + 1})` : ''}
              </span>
              <Badge
                variant="outline"
                className={cn(
                  'text-[9px] h-3.5 px-1 shrink-0',
                  bead.status === 'completed' && 'border-green-600/40 text-green-700 dark:text-green-400',
                  bead.status === 'in_progress' && 'border-primary/40 text-primary',
                  bead.status === 'failed' && 'border-red-600/40 text-red-700 dark:text-red-400',
                )}
              >
                {bead.status.replace('_', ' ')}
              </Badge>
            </div>
            {bead.description && (
              <p className="text-[11px] text-muted-foreground leading-snug line-clamp-3">{bead.description}</p>
            )}
            {bead.iteration > 0 && (
              <div className="text-[10px] text-muted-foreground">Iteration: {bead.iteration}</div>
            )}
            <button
              type="button"
              onClick={() => onSelectBead(bead.id)}
              className="text-[10px] text-primary hover:underline"
            >
              View bead →
            </button>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground italic">Bead not found</div>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}

function TargetFileRow({ file }: { file: string }) {
  const [copied, handleCopy] = useCopyToClipboard(COPY_SUCCESS_DISPLAY_SHORT_MS)

  return (
    <div className="group flex items-center gap-1">
      <Tooltip>
            <TooltipTrigger asChild>
              <code className="block text-[11px] bg-muted px-1.5 py-0.5 rounded font-mono truncate flex-1">{file}</code>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-center text-balance">{file}</TooltipContent>
          </Tooltip>
      <Tooltip>
            <TooltipTrigger asChild>
              <button
                  type="button"
                  aria-label="Copy path"
                  onClick={() => handleCopy(file)}
                  className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-accent"
                >
                  {copied
                    ? <Check className="h-3 w-3 text-green-500" />
                    : <Copy className="h-3 w-3 text-muted-foreground hover:text-foreground" />}
                </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-center text-balance">Copy path</TooltipContent>
          </Tooltip>
    </div>
  )
}

function BeadDetailTabButton({
  tab,
  activeTab,
  disabled = false,
  onSelect,
  icon,
  children,
}: {
  tab: BeadDetailTab
  activeTab: BeadDetailTab
  disabled?: boolean
  onSelect: (tab: BeadDetailTab) => void
  icon: React.ReactNode
  children: React.ReactNode
}) {
  const button = (
    <button
      type="button"
      onClick={() => {
        if (!disabled) onSelect(tab)
      }}
      disabled={disabled}
      className={cn(
        'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-b-2',
        activeTab === tab
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
        disabled && 'opacity-40 cursor-not-allowed hover:text-muted-foreground',
      )}
    >
      {icon}
      {children}
    </button>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" title={BEAD_TAB_TOOLTIPS[tab]}>{button}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-center text-balance">{BEAD_TAB_TOOLTIPS[tab]}</TooltipContent>
    </Tooltip>
  )
}

function BeadRawAttemptPanel({
  mode,
  attempt,
  content,
  emptyMessage,
}: {
  mode: 'input' | 'output'
  attempt: BeadRawAttempt | null
  content: string
  emptyMessage: string
}) {
  const displayContent = useMemo(() => buildReadableRawDisplayContent(content), [content])

  return (
    <div className="flex-1 min-h-0 overflow-auto p-3">
      {content.trim() ? (
        <div className="min-w-0 max-w-full space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
            {attempt ? <span className="rounded border border-border bg-background px-2 py-1">Iteration {attempt.iteration}</span> : null}
            {attempt?.modelId ? <span className="rounded border border-border bg-background px-2 py-1">Model {attempt.modelId}</span> : null}
            {attempt?.sessionId ? <span className="rounded border border-border bg-background px-2 py-1">Session {attempt.sessionId}</span> : null}
          </div>
          <RawDisplayStats content={displayContent} />
          <RawDisplayPre content={displayContent} />
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border bg-background/60 p-4 text-xs text-muted-foreground">
          {emptyMessage || `No raw ${mode} for this bead yet.`}
        </div>
      )}
    </div>
  )
}

function BeadGrid({
  beads,
  viewingBeadId,
  onSelect,
}: {
  beads: TicketBead[]
  viewingBeadId: string | null
  onSelect: (id: string | null) => void
}) {
  const compact = beads.length > COMPACT_THRESHOLD

  if (compact) {
    return (
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(28px, 1fr))` }}
      >
        {beads.map((bead, index) => (
          <Tooltip key={bead.id}>
              <TooltipTrigger asChild>
                <button
                          onClick={() => onSelect(viewingBeadId === bead.id ? null : bead.id)}
                          className={cn(
                            'h-7 w-full rounded text-[10px] font-mono font-medium transition-colors',
                            bead.status === 'completed' || bead.status === 'skipped'
                              ? 'bg-green-500/20 text-green-700 dark:text-green-400 border border-green-600/20'
                              : bead.status === 'in_progress'
                                ? 'bg-primary/20 text-primary border border-primary/40 animate-pulse'
                                : bead.status === 'failed'
                                  ? 'bg-red-500/20 text-red-700 dark:text-red-400 border border-red-600/20'
                                  : 'bg-muted text-muted-foreground border border-border opacity-60',
                            viewingBeadId === bead.id && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
                          )}
                        >
                          {index + 1}
                        </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-center text-balance">{`#${index + 1}: ${bead.title}${bead.iteration > 0 ? ` (${bead.iteration}x)` : ''}`}</TooltipContent>
            </Tooltip>
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {beads.map((bead, index) => (
        <Tooltip key={bead.id}>
            <TooltipTrigger asChild>
              <button
                      onClick={() => onSelect(viewingBeadId === bead.id ? null : bead.id)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs whitespace-nowrap transition-colors',
                        bead.status === 'in_progress' && 'border-primary bg-primary/10 font-medium animate-pulse',
                        (bead.status === 'completed' || bead.status === 'skipped') && 'border-green-600/30 bg-green-50 dark:bg-green-900/20',
                        bead.status === 'failed' && 'border-red-600/30 bg-red-50 dark:bg-red-900/20',
                        bead.status === 'pending' && 'border-border opacity-70',
                        viewingBeadId === bead.id && 'ring-2 ring-primary',
                      )}
                    >
                      {statusIcon(bead.status)}
                      <span>{bead.title || `Bead ${index + 1}`}</span>
                      {bead.qaOrigin && <Badge variant="secondary" className="h-4 px-1 text-[9px]">Manual QA Fix</Badge>}
                      {bead.iteration > 0 && (
                        <Badge variant="outline" className="text-[10px] h-4 px-1">
                          {bead.iteration}x
                        </Badge>
                      )}
                    </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-center text-balance">{bead.title}</TooltipContent>
          </Tooltip>
      ))}
    </div>
  )
}

export function CodingView({ ticket, readOnly }: CodingViewProps) {
  const [rawViewingBeadId, setViewingBeadId] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<BeadDetailTab>('details')
  const [selectedRawIteration, setSelectedRawIteration] = useState<number | null>(null)
  const [showAllBeadLogs, setShowAllBeadLogs] = useState(false)
  const phaseForView = readOnly ? 'CODING' : ticket.status
  const hasBeadControls = phaseForView === 'CODING'
  const viewingBeadId = hasBeadControls ? rawViewingBeadId : null
  const shouldShowPhaseVersionSelector = phaseForView !== 'CODING'
  const {
    attempts: phaseAttempts,
    selectedAttempt,
    setManualSelectedAttemptNumber,
    archivedAttemptNumber,
    logPhaseAttempt,
    logMode,
    isError: isPhaseAttemptsError,
    error: phaseAttemptsError,
    refetch: refetchPhaseAttempts,
  } = useSelectedPhaseAttempt(
    shouldShowPhaseVersionSelector ? ticket.id : undefined,
    shouldShowPhaseVersionSelector ? phaseForView : undefined,
  )
  const attemptNumber = selectedAttemptNumber(selectedAttempt, phaseAttempts)
  const archivedArtifactState = useTicketArtifacts(
    archivedAttemptNumber != null ? ticket.id : undefined,
    archivedAttemptNumber != null
      ? { phase: phaseForView, phaseAttempt: archivedAttemptNumber }
      : undefined,
  )
  const { artifacts: loadedCodingPhaseArtifacts } = useTicketArtifacts(
    viewingBeadId ? ticket.id : undefined,
    viewingBeadId ? { phase: 'CODING' } : undefined,
  )
  const codingPhaseArtifacts = useMemo(() => loadedCodingPhaseArtifacts ?? [], [loadedCodingPhaseArtifacts])
  
  // -- Auto-scroll state for the model log tab --
  const viewportRef = useRef<HTMLDivElement>(null)
  const autoScrollEnabledRef = useRef(true)
  const scrollFrameRef = useRef<number | null>(null)
  const [isAutoScroll, setIsAutoScroll] = useState(true)
  const [isAtTop, setIsAtTop] = useState(true)

  const scheduleScrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const scroll = () => {
      const el = viewportRef.current
      if (!el) return
      el.scrollTo({ top: el.scrollHeight, behavior })
    }
    if (behavior === 'auto') {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
        scrollFrameRef.current = null
      }
      scroll()
      return
    }
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current)
    }
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      scroll()
    })
  }, [])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      const atBottom = distanceFromBottom <= 50
      autoScrollEnabledRef.current = atBottom
      setIsAutoScroll((prev) => (prev !== atBottom ? atBottom : prev))
      const atTop = el.scrollTop <= 50
      setIsAtTop((prev) => (prev !== atTop ? atTop : prev))
    }
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [detailTab]) // re-bind when tab swaps in case the node remounts

  useEffect(() => {
    if (detailTab === 'model') {
      if (autoScrollEnabledRef.current) {
        scheduleScrollToBottom('auto')
      }
    }
  }, [detailTab, scheduleScrollToBottom])

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
        scrollFrameRef.current = null
      }
    }
  }, [])

  const logCtx = useLogs()
  // The loader is identity-stable and the reader is rebound only when rows change, so
  // neither the fetch effect nor this memo re-runs merely because a line arrived through
  // some other panel.
  const loadLogsForPhase = logCtx?.loadLogsForPhase
  const getLogsForPhase = logCtx?.getLogsForPhase
  const { mutate: performAction, mutateAsync: performActionAsync, isPending } = useTicketAction()
  const {
    data: fetchedBeads = [],
    isError: isBeadsError,
    error: beadsError,
    refetch: refetchBeads,
  } = useQuery({
    queryKey: ['ticket-beads', ticket.id],
    queryFn: ({ signal }) => fetchTicketBeads(ticket.id, signal),
    enabled: hasBeadControls && ticket.runtime.totalBeads > 0,
    placeholderData: hasBeadControls
      ? (ticket.runtime.beads ?? []).map((bead) => normalizeBead(bead))
      : [],
    staleTime: QUERY_STALE_TIME_5S,
    refetchOnMount: false,
  })
  const beads = useMemo(
    () => hasBeadControls
      ? mergeBeadRuntimeOverlay(fetchedBeads, ticket.runtime.beads)
      : [],
    [fetchedBeads, hasBeadControls, ticket.runtime.beads],
  )

  const total = ticket.runtime.totalBeads || beads.length
  const current = ticket.runtime.currentBead
  const percent = ticket.runtime.percentComplete
  const activeIteration = ticket.runtime.activeBeadIteration
  const maxIterationsPerBead = ticket.runtime.maxIterationsPerBead
  const activeBead = ticket.runtime.activeBeadId
    ? beads.find((bead) => bead.id === ticket.runtime.activeBeadId)
    : null
  const phaseLabel = getStatusUserLabel(phaseForView, {
    currentBead: current,
    totalBeads: total,
    errorMessage: ticket.errorMessage,
  })
  const isCompleted = shouldShowCompletedCodingState(ticket, readOnly)
  const shouldShowArtifactsPanel = phaseForView !== 'CODING' || isCompleted
  const isAwaitingManualVerification = !readOnly && ticket.status === 'WAITING_PR_REVIEW'
  const viewedBead = useMemo(
    () => beads.find((bead) => bead.id === viewingBeadId) ?? null,
    [beads, viewingBeadId],
  )
  const { prd, isLoading: prdLoading, isError: prdError } = usePrdDocument(ticket.id)
  const historicalBeadLogs = useTicketHistoricalLogs(ticket.id, {
    scope: 'phase',
    phase: 'CODING',
    phaseAttempt: logPhaseAttempt,
    view: 'ai',
    beadId: viewedBead?.id,
  }, Boolean(viewedBead))
  const {
    entries: historicalBeadLogEntries,
    fetchAllOlder: fetchAllHistoricalBeadLogs,
    hasOlder: hasOlderHistoricalBeadLogs,
  } = historicalBeadLogs
  const beadLogEntries = useMemo(() => {
    if (!viewedBead) return []
    const phaseLogs = getLogsForPhase?.(phaseForView, { phaseAttempt: logPhaseAttempt }) ?? []
    const beadLogs = mergeEntriesBatch(
      historicalBeadLogEntries,
      phaseLogs,
    ).filter((entry) => entry.beadId === viewedBead.id)
    return filterBeadLogEntries(beadLogs)
  }, [getLogsForPhase, historicalBeadLogEntries, logPhaseAttempt, phaseForView, viewedBead])

  // Draining the archive is a loop of requests, so it needs an owner. The token is
  // released when the bead or the attempt changes and on unmount, which stops the loop
  // writing pages into a query nobody is showing any more. A failed page ends the drain
  // rather than restarting it: `hasOlder` stays true after an error, so retrying here
  // is an unbounded request loop against a server that just said no.
  //
  // Nothing that moves while the walk is running belongs in this dependency list. The
  // in-flight flag and the bead object both do — React Query raises the flag as the
  // first page leaves, and `beads.find` is a fresh object on every bead refetch — and
  // either one re-runs this effect, whose cleanup then cancels the walk it just started.
  // A failure arriving after that reads as a cancellation, so the latch below never
  // closes and the retry loop runs anyway.
  const beadLogDrainKey = `${viewedBead?.id ?? 'none'}:${logPhaseAttempt ?? 'active'}`
  const failedBeadLogDrainRef = useRef<string | null>(null)
  const viewedBeadId = viewedBead?.id ?? null
  useEffect(() => {
    if (!viewedBeadId || !hasOlderHistoricalBeadLogs) return
    if (failedBeadLogDrainRef.current === beadLogDrainKey) return

    const drain = { cancelled: false }
    void fetchAllHistoricalBeadLogs(() => drain.cancelled).catch(() => {
      // Only a walk that was still wanted counts as a failure. Now that nothing moving
      // is in the dependency list, a cancelled walk means the user genuinely left, and
      // latching that would blame this bead for a page it was never waiting on.
      if (drain.cancelled) return
      failedBeadLogDrainRef.current = beadLogDrainKey
    })
    return () => {
      drain.cancelled = true
    }
  }, [beadLogDrainKey, fetchAllHistoricalBeadLogs, hasOlderHistoricalBeadLogs, viewedBeadId])

  // The latch covers one continuous look at one bead, not the bead forever. It is
  // released on the way out, so coming back tries again — otherwise a single refused
  // page hides the rest of that bead's history for the life of the view, and there is no
  // other way to ask for it.
  useEffect(() => {
    return () => {
      failedBeadLogDrainRef.current = null
    }
  }, [beadLogDrainKey])

  useEffect(() => {
    if (!viewedBeadId || !loadLogsForPhase) return
    loadLogsForPhase('CODING', { channel: 'ai', phaseAttempt: logPhaseAttempt })
  }, [loadLogsForPhase, logPhaseAttempt, viewedBeadId])

  useEffect(() => {
    setSelectedRawIteration(null)
    setShowAllBeadLogs(false)
  }, [viewedBead?.id])

  const beadRawAttempts = useMemo(() => {
    if (!viewedBead) return []
    const persisted = parseBeadExecutionAttempts(codingPhaseArtifacts, viewedBead.id)
    const logDerived = buildLogDerivedRawAttempts(beadLogEntries, viewedBead.iteration > 0 ? viewedBead.iteration : 1)
    return mergeRawAttempts(persisted, logDerived)
  }, [beadLogEntries, codingPhaseArtifacts, viewedBead])

  const defaultRawAttemptKey = useMemo(
    () => selectDefaultRawAttemptKey(beadRawAttempts, viewedBead),
    [beadRawAttempts, viewedBead],
  )

  useEffect(() => {
    if (!viewedBead) return
    if (selectedRawIteration !== null && beadRawAttempts.some((attempt) => getRawAttemptKey(attempt) === selectedRawIteration)) return
    setSelectedRawIteration(defaultRawAttemptKey)
  }, [beadRawAttempts, defaultRawAttemptKey, selectedRawIteration, viewedBead])

  const activeRawAttempt = useMemo(() => {
    if (beadRawAttempts.length === 0) return null
    const selected = selectedRawIteration !== null
      ? beadRawAttempts.find((attempt) => getRawAttemptKey(attempt) === selectedRawIteration)
      : null
    return selected
      ?? (defaultRawAttemptKey !== null ? beadRawAttempts.find((attempt) => getRawAttemptKey(attempt) === defaultRawAttemptKey) : null)
      ?? beadRawAttempts[beadRawAttempts.length - 1]
      ?? null
  }, [beadRawAttempts, defaultRawAttemptKey, selectedRawIteration])

  const activeRawInput = getRawAttemptInput(activeRawAttempt)
  const activeRawOutput = getRawAttemptOutput(activeRawAttempt)
  const selectedBeadLogEntries = useMemo(() => {
    if (showAllBeadLogs || !activeRawAttempt) return beadLogEntries

    const iterationBounds = getIterationLogBounds(beadLogEntries, activeRawAttempt.iteration)
    const entriesForIteration = beadLogEntries.filter((entry, index) => {
      if (entry.beadIteration !== undefined && entry.beadIteration !== activeRawAttempt.iteration) return false
      return !iterationBounds || (index >= iterationBounds.start && index < iterationBounds.end)
    })
    // Older logs may not carry iteration metadata. Keep them visible when
    // there is only one known iteration, but do not mix them into a view with
    // multiple iterations where their origin cannot be determined safely.
    if (entriesForIteration.length > 0 || beadRawAttempts.length > 1) return entriesForIteration
    return beadLogEntries
  }, [activeRawAttempt, beadLogEntries, beadRawAttempts.length, showAllBeadLogs])
  const hasMultipleBeadIterations = beadRawAttempts.length > 1
  const beadLogViewKey = showAllBeadLogs
    ? `${viewedBead?.id ?? 'none'}:all`
    : `${viewedBead?.id ?? 'none'}:${activeRawAttempt?.iteration ?? 'none'}`
  const activeIterationForLabel = viewedBead?.status === 'in_progress'
    ? viewedBead.iteration
    : ticket.runtime.activeBeadId === viewedBead?.id
      ? ticket.runtime.activeBeadIteration
      : null
  const outputContextIsTerminal = isRawAttemptTerminal(activeRawAttempt, viewedBead)
    || ticket.status === 'CANCELED'
    || ticket.status === 'BLOCKED_ERROR'
  const outputTabEnabled = Boolean(activeRawOutput.trim()) && outputContextIsTerminal
  const activeRawCopyContent = detailTab === 'input'
    ? activeRawInput
    : detailTab === 'output' && outputTabEnabled
      ? activeRawOutput
      : ''
  const changesTabEnabled = viewedBead ? (viewedBead.status === 'completed' || viewedBead.status === 'skipped') : false

  useEffect(() => {
    if (detailTab === 'output' && !outputTabEnabled) {
      setDetailTab('input')
    }
  }, [detailTab, outputTabEnabled])

  useEffect(() => {
    if (detailTab === 'changes' && !changesTabEnabled) {
      setDetailTab('details')
    }
  }, [changesTabEnabled, detailTab])

  const [copied, copyToClipboard] = useCopyToClipboard()
  const handleCopyLogs = useCallback(() => {
    if (!selectedBeadLogEntries.length) return
    const textToCopy = selectedBeadLogEntries.map((entry) => {
      const ts = entry.timestamp ? `[${entry.timestamp}] ` : ''
      return `${ts}${formatLogLine(entry, true).copyText}`
    }).join('\n')
    copyToClipboard(textToCopy)
  }, [copyToClipboard, selectedBeadLogEntries])
  
  // The row count is not the signal. A streaming model answer arrives as repeated
  // upserts of one row whose `line` grows, so the length never moves and the view sat
  // still while text was still coming in. This tracks the tail itself — which row it is
  // and how long it has become — the same signature `PhaseLogPanel` follows.
  const visibleBeadLogTail = useMemo(() => {
    const lastEntry = selectedBeadLogEntries.at(-1)
    if (!lastEntry) return null
    return [
      selectedBeadLogEntries.length,
      lastEntry.entryId,
      lastEntry.line.length,
      lastEntry.streaming ? 'streaming' : 'static',
      lastEntry.op,
    ].join('|')
  }, [selectedBeadLogEntries])

  useEffect(() => {
    if (detailTab === 'model' && autoScrollEnabledRef.current) {
      scheduleScrollToBottom('smooth')
    }
  }, [detailTab, scheduleScrollToBottom, visibleBeadLogTail])

  const isViewingOther = viewedBead !== null

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-4 py-2 border-b border-border flex items-center gap-3 shrink-0">
        {isCompleted
          ? <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
          : <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />}
        <span className="text-sm font-medium">
          {isCompleted ? 'Completed Successfully' : phaseLabel}
        </span>
        {hasBeadControls && (
          <>
            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className={cn('h-full transition-all duration-500', isCompleted ? 'bg-green-600' : 'bg-primary')}
                style={{ width: `${isCompleted ? 100 : percent}%` }}
              />
            </div>
            <span className="text-xs font-mono text-muted-foreground shrink-0">
              {isCompleted ? `${Math.max(total, 0)}/${Math.max(total, 0)}` : `${current}/${Math.max(total, 0)}`}
            </span>
          </>
        )}
        {hasBeadControls && activeIteration && activeIteration > 0 && (
          <span className="text-[11px] text-muted-foreground shrink-0">
            {activeBead?.title ?? ticket.runtime.activeBeadId ?? 'Bead'} · Iteration {activeIteration}
            {maxIterationsPerBead && maxIterationsPerBead > 0 ? `/${maxIterationsPerBead}` : ''}
          </span>
        )}
      </div>

      {shouldShowPhaseVersionSelector && isPhaseAttemptsError ? (
        <div className="px-4 border-b border-border shrink-0">
          <PhaseAttemptsUnavailable
            error={phaseAttemptsError}
            onRetry={() => void refetchPhaseAttempts()}
          />
        </div>
      ) : null}

      {shouldShowPhaseVersionSelector && attemptNumber !== undefined && phaseAttempts.length > 1 ? (
        <div className="px-4 py-2 border-b border-border shrink-0">
          <PhaseAttemptSelector
            attempts={phaseAttempts}
            value={attemptNumber}
            onChange={setManualSelectedAttemptNumber}
          />
        </div>
      ) : null}

      {isAwaitingManualVerification && (
        <VerificationSummaryPanel
          ticket={ticket}
          onMerge={() => performAction({ id: ticket.id, action: 'merge' })}
          onCloseUnmerged={(reason) => performActionAsync({
            id: ticket.id,
            action: 'close_unmerged',
            payload: { kind: 'close_reason', reason },
          }).then(() => undefined)}
          isPending={isPending}
        />
      )}

      {isViewingOther && viewedBead && (
        <div className="px-4 py-1.5 border-b border-border bg-accent/50 flex items-center gap-2 shrink-0">
          <Eye className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            Viewing <span className="font-medium text-foreground">{viewedBead.title}</span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setViewingBeadId(null)}
            className="text-xs h-6 px-2 mx-auto"
          >
            {readOnly || isCompleted ? 'Close' : 'Back to live'}
          </Button>
        </div>
      )}

      {hasBeadControls && isBeadsError && (
        <div className="px-4 border-b border-border shrink-0">
          <QueryErrorNotice
            title="The bead list could not be refreshed. Anything shown below is the last known state."
            error={beadsError}
            onRetry={() => void refetchBeads()}
          />
        </div>
      )}

      {hasBeadControls && beads.length > 0 && (
        <div className="px-4 py-2 border-b border-border shrink-0">
          <BeadGrid beads={beads} viewingBeadId={viewingBeadId} onSelect={setViewingBeadId} />
        </div>
      )}

      {shouldShowArtifactsPanel && (
        <div className="px-3 py-1.5 border-b border-border shrink-0">
          <PhaseArtifactsPanel
            phase={phaseForView}
            isCompleted={isCompleted}
            ticketId={ticket.id}
            artifactState={archivedAttemptNumber != null ? archivedArtifactState : undefined}
          />
        </div>
      )}

      <div className="flex-1 min-h-0 px-2 py-2 flex flex-col">
        {viewedBead ? (
          <div className="flex-1 min-h-0 flex flex-col rounded-md border border-border bg-muted/30 overflow-hidden">
            <div className="flex items-center border-b border-border shrink-0">
              <BeadDetailTabButton tab="details" activeTab={detailTab} onSelect={setDetailTab} icon={<List className="h-3 w-3" />}>
                Details
              </BeadDetailTabButton>
              <BeadDetailTabButton
                tab="changes"
                activeTab={detailTab}
                onSelect={setDetailTab}
                disabled={!changesTabEnabled}
                icon={<FileCode2 className="h-3 w-3" />}
              >
                Changes
              </BeadDetailTabButton>
              <BeadDetailTabButton tab="model" activeTab={detailTab} onSelect={setDetailTab} icon={<Brain className="h-3 w-3" />}>
                Log
              </BeadDetailTabButton>
              <BeadDetailTabButton tab="input" activeTab={detailTab} onSelect={setDetailTab} icon={<FileInput className="h-3 w-3" />}>
                Input
              </BeadDetailTabButton>
              {detailTab === 'input' && activeRawCopyContent.trim() && (
                <div className="flex items-center pr-1">
                  <RawCopyButton content={activeRawCopyContent} title="Copy bead input" />
                </div>
              )}
              <BeadDetailTabButton
                tab="output"
                activeTab={detailTab}
                onSelect={setDetailTab}
                disabled={!outputTabEnabled}
                icon={<FileOutput className="h-3 w-3" />}
              >
                Output
              </BeadDetailTabButton>
              {detailTab === 'output' && activeRawCopyContent.trim() && (
                <div className="flex items-center pr-1">
                  <RawCopyButton content={activeRawCopyContent} title="Copy bead output" />
                </div>
              )}

              {detailTab === 'model' && (
                <div className="ml-auto flex items-center pr-2 gap-2 text-xs text-muted-foreground">
                  {hasMultipleBeadIterations && (
                    <button
                      type="button"
                      aria-pressed={showAllBeadLogs}
                      onClick={() => {
                        if (showAllBeadLogs) {
                          setShowAllBeadLogs(false)
                          setSelectedRawIteration(defaultRawAttemptKey)
                          return
                        }
                        setSelectedRawIteration(null)
                        setShowAllBeadLogs(true)
                      }}
                      className={cn(
                        'rounded border px-2 py-1 transition-colors',
                        showAllBeadLogs
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-background hover:bg-accent hover:text-foreground',
                      )}
                    >
                      {showAllBeadLogs ? 'Show selected iteration logs' : 'Show all logs for bead'}
                    </button>
                  )}
                  <Tooltip delayDuration={200}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="flex items-center cursor-help px-1 py-0.5 rounded hover:bg-muted transition-colors border-none bg-transparent m-0 focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        <span>{selectedBeadLogEntries.length} entries</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" align="end" className="flex flex-col gap-1.5 p-2 bg-popover text-popover-foreground border border-border font-medium shadow-md">
                      <LogColorLegend />
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="Copy bead logs"
                        onClick={handleCopyLogs}
                        disabled={selectedBeadLogEntries.length === 0}
                        className="flex items-center justify-center p-1 rounded hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs text-center text-balance">Copy bead logs</TooltipContent>
                  </Tooltip>
                </div>
              )}
            </div>

            {beadRawAttempts.length > 1 && (
              <div className="flex min-w-0 items-center gap-2 border-b border-border bg-background/70 px-2 py-1.5 text-xs">
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Versions</span>
                <div role="group" aria-label="Bead raw versions" className="flex min-w-0 flex-wrap gap-1">
                  {beadRawAttempts.map((attempt) => {
                    const key = getRawAttemptKey(attempt)
                    const active = !showAllBeadLogs && activeRawAttempt
                      ? getRawAttemptKey(activeRawAttempt) === key
                      : false
                    const label = `Iteration ${attempt.iteration}`
                    const outcomeLabel = getRawAttemptOutcome(attempt)
                      ? formatRawAttemptOutcome(attempt)
                      : attempt.iteration === activeIterationForLabel ? 'In progress' : 'Rejected'
                    return (
                      <Tooltip key={`${attempt.iteration}-${attempt.attempt}`}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-pressed={active}
                            onClick={() => {
                              setSelectedRawIteration(key)
                              setShowAllBeadLogs(false)
                            }}
                            className={cn(
                              'inline-flex min-w-0 max-w-full items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium transition-colors',
                              active
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border bg-background text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                            )}
                          >
                            <span className="truncate">{label}</span>
                            <span className="text-[9px] opacity-80">{outcomeLabel}</span>
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs text-center text-balance">
                          {`${label} - ${outcomeLabel}`}
                        </TooltipContent>
                      </Tooltip>
                    )
                  })}
                </div>
              </div>
            )}

            {detailTab === 'model' ? (
              <div className="relative flex-1 min-h-0 flex flex-col">
                <ScrollArea key={beadLogViewKey} className="flex-1 min-h-0 h-full" viewportRef={viewportRef}>
                  <div className="font-mono text-xs bg-muted rounded-md p-3 min-h-[100px] w-full max-w-full">
                    {selectedBeadLogEntries.length > 0 ? (
                      selectedBeadLogEntries.map((entry, i) => (
                        <LogEntryRow key={getLogEntryIdentity(entry)} entry={entry} index={i} showModelName />
                      ))
                    ) : (
                      <span className="text-muted-foreground/50 italic">No logs for this bead.</span>
                    )}
                  </div>
                </ScrollArea>
                {selectedBeadLogEntries.length > 0 && !isAtTop && (
                  <Tooltip delayDuration={300}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => viewportRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
                        className="absolute top-4 right-6 p-2 bg-background/20 hover:bg-background backdrop-blur-sm border border-border/40 hover:border-border rounded-full shadow-sm hover:shadow pointer-events-auto text-muted-foreground hover:text-foreground transition-all z-10 opacity-40 hover:opacity-100"
                      >
                        <ArrowUpToLine className="w-4 h-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="text-xs">Go to top</TooltipContent>
                  </Tooltip>
                )}
                {selectedBeadLogEntries.length > 0 && !isAutoScroll && (
                  <Tooltip delayDuration={300}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => {
                          autoScrollEnabledRef.current = true
                          setIsAutoScroll(true)
                          scheduleScrollToBottom('smooth')
                        }}
                        className="absolute bottom-4 right-6 p-2 bg-background/20 hover:bg-background backdrop-blur-sm border border-border/40 hover:border-border rounded-full shadow-sm hover:shadow pointer-events-auto text-muted-foreground hover:text-foreground transition-all z-10 opacity-40 hover:opacity-100"
                      >
                        <ArrowDownToLine className="w-4 h-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="text-xs">Back to bottom</TooltipContent>
                  </Tooltip>
                )}
              </div>
            ) : detailTab === 'input' ? (
              <BeadRawAttemptPanel
                mode="input"
                attempt={activeRawAttempt}
                content={activeRawInput}
                emptyMessage="No raw input for this bead yet."
              />
            ) : detailTab === 'output' ? (
              <BeadRawAttemptPanel
                mode="output"
                attempt={activeRawAttempt}
                content={outputTabEnabled ? activeRawOutput : ''}
                emptyMessage="No model output for this bead yet."
              />
            ) : detailTab === 'changes' && changesTabEnabled ? (
              <div className="flex-1 min-h-0 overflow-auto">
                <BeadDiffViewer ticketId={ticket.id} beadId={viewedBead.id} />
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
                {/* Header: title + ID */}
                <div>
                  <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {viewedBead.title}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-[10px]">{viewedBead.id}</code>
                    {viewedBead.priority > 0 && (
                      <span className="flex items-center gap-0.5">
                        <span className="font-medium text-foreground">#{viewedBead.priority}</span> priority
                      </span>
                    )}
                    {viewedBead.issueType && (
                      <Badge variant="outline" className="text-[10px] h-4 px-1.5">{viewedBead.issueType}</Badge>
                    )}
                    {viewedBead.qaOrigin && (
                      <Badge className="h-4 bg-amber-500/15 px-1.5 text-[10px] text-amber-700 hover:bg-amber-500/20 dark:text-amber-300">Manual QA Fix · v{viewedBead.qaOrigin.version}</Badge>
                    )}
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-[10px] h-4 px-1.5',
                        viewedBead.status === 'completed' && 'border-green-600/40 text-green-700 dark:text-green-400',
                        viewedBead.status === 'in_progress' && 'border-primary/40 text-primary',
                        viewedBead.status === 'failed' && 'border-red-600/40 text-red-700 dark:text-red-400',
                      )}
                    >
                      {viewedBead.status.replace('_', ' ')}
                    </Badge>
                    {viewedBead.iteration > 0 && (
                      <span>iteration {viewedBead.iteration}</span>
                    )}
                  </div>
                </div>

                {/* Description */}
                <p className="text-sm whitespace-pre-wrap">{viewedBead.description || 'No bead description available.'}</p>

                {viewedBead.qaOrigin && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-300">Manual QA origin · Round v{viewedBead.qaOrigin.version}</div>
                    <div className="mt-2 space-y-3">
                      {viewedBead.qaOrigin.sourceItems.map((source) => (
                        <div key={source.itemId} className="text-xs">
                          <p className="font-medium">{source.title ?? source.behavior ?? source.itemId} <code className="ml-1 text-[10px] text-muted-foreground">{source.itemId}</code></p>
                          <p className="mt-1"><span className="font-medium text-red-700 dark:text-red-300">Observed:</span> {source.observation}</p>
                          <p className="mt-1"><span className="font-medium text-green-700 dark:text-green-300">Expected:</span> {source.expectedResult}</p>
                          {((source.evidence ?? source.evidenceRefs)?.length ?? 0) > 0 && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {(source.evidence ?? source.evidenceRefs)?.map((reference, index) => {
                                const evidence = typeof reference === 'string' ? { name: reference } : reference
                                const evidenceName = String(evidence.name ?? ('originalName' in evidence ? evidence.originalName : '') ?? '') || 'Evidence'
                                const evidenceType = String(evidence.mediaType ?? ('mimeType' in evidence ? evidence.mimeType : '') ?? '')
                                const apiEvidenceUrl = viewedBead.qaOrigin?.sourceTicketId && evidence.id
                                  ? manualQaEvidenceUrl(viewedBead.qaOrigin.sourceTicketId, viewedBead.qaOrigin.version, source.itemId, evidence.id)
                                  : ''
                                const evidenceUrl = typeof evidence.url === 'string' ? evidence.url : apiEvidenceUrl
                                const safePreview = evidenceUrl && ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(evidenceType)
                                const previewUrl = apiEvidenceUrl ? `${apiEvidenceUrl}?inline=true` : evidenceUrl
                                return evidenceUrl ? <a key={evidence.id ?? `${evidenceName}:${index}`} href={evidenceUrl} target="_blank" rel="noreferrer" className="rounded border border-border bg-background p-1 text-[10px] text-primary hover:underline">{safePreview && <img src={previewUrl} alt={evidenceName} className="mb-1 h-16 max-w-28 object-contain" />}{evidenceName}</a> : <Badge key={`${evidenceName}:${index}`} variant="outline" className="text-[10px]">{evidenceName}</Badge>
                              })}
                            </div>
                          )}
                          {(source.links?.length ?? 0) > 0 && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {source.links?.map((link, index) => <a key={link.id ?? `${link.url}:${index}`} href={link.url} target="_blank" rel="noreferrer" className="rounded border border-border bg-background px-2 py-1 text-[10px] text-primary hover:underline">{link.label || link.url}</a>)}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Timestamps */}
                {(viewedBead.createdAt || viewedBead.startedAt || viewedBead.updatedAt || viewedBead.completedAt) && (
                  <div className="border-l-2 border-sky-300 dark:border-sky-700 pl-2">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-sky-600 dark:text-sky-400 mb-1 flex items-center gap-1">
                      <Clock className="h-3 w-3" /> Timeline
                    </div>
                    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                      {viewedBead.createdAt && (
                        <>
                          <span className="text-muted-foreground">Created</span>
                          <span>{formatTimestamp(viewedBead.createdAt)} <span className="text-muted-foreground/60">({relativeTime(viewedBead.createdAt)})</span></span>
                        </>
                      )}
                      {viewedBead.startedAt && (
                        <>
                          <span className="text-muted-foreground">Started</span>
                          <span>{formatTimestamp(viewedBead.startedAt)} <span className="text-muted-foreground/60">({relativeTime(viewedBead.startedAt)})</span></span>
                        </>
                      )}
                      {viewedBead.updatedAt && (
                        <>
                          <span className="text-muted-foreground">Updated</span>
                          <span>{formatTimestamp(viewedBead.updatedAt)} <span className="text-muted-foreground/60">({relativeTime(viewedBead.updatedAt)})</span></span>
                        </>
                      )}
                      {viewedBead.completedAt && (
                        <>
                          <span className="text-muted-foreground">Completed</span>
                          <span>{formatTimestamp(viewedBead.completedAt)} <span className="text-muted-foreground/60">({relativeTime(viewedBead.completedAt)})</span></span>
                        </>
                      )}
                      {viewedBead.startedAt && viewedBead.completedAt && (() => {
                        const start = Date.parse(viewedBead.startedAt)
                        const end = Date.parse(viewedBead.completedAt)
                        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
                          return (
                            <>
                              <span className="text-muted-foreground">Implementation Time</span>
                              <span>{formatElapsedDuration(end - start)}</span>
                            </>
                          )
                        }
                        return null
                      })()}
                    </div>
                  </div>
                )}

                {/* External Ref + Bead Start Commit */}
                {(viewedBead.externalRef || viewedBead.beadStartCommit) && (
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    {viewedBead.externalRef && (
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <Link2 className="h-3 w-3" /> Ref: <code className="bg-muted px-1 py-0.5 rounded font-mono text-[10px]">{viewedBead.externalRef}</code>
                      </span>
                    )}
                    {viewedBead.beadStartCommit && (
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <GitCommit className="h-3 w-3" /> Start commit: <code className="bg-muted px-1 py-0.5 rounded font-mono text-[10px]">{viewedBead.beadStartCommit.slice(0, 8)}</code>
                      </span>
                    )}
                  </div>
                )}

                {/* PRD Refs */}
                {viewedBead.prdRefs.length > 0 && (
                  <div className="border-l-2 border-indigo-300 dark:border-indigo-700 pl-2">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-indigo-600 dark:text-indigo-400 mb-1">PRD References</div>
                    <div className="flex flex-wrap gap-1">
                      {viewedBead.prdRefs.map((ref, i) => (
                        <PrdRefHoverCard key={`prd-${ref}-${i}`} refId={ref} prd={prd} isLoading={prdLoading} isError={prdError} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Labels */}
                {viewedBead.labels.length > 0 && (
                  <div className="border-l-2 border-pink-300 dark:border-pink-700 pl-2">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-pink-600 dark:text-pink-400 mb-1 flex items-center gap-1">
                      <Tag className="h-3 w-3" /> Labels
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {viewedBead.labels.map((label, i) => (
                        <LabelHoverCard key={`label-${label}-${i}`} label={label} beads={beads} currentBeadId={viewedBead.id} onSelectBead={setViewingBeadId} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Dependencies */}
                {(viewedBead.dependencies.blocked_by.length > 0 || viewedBead.dependencies.blocks.length > 0) && (
                  <div className="border-l-2 border-orange-300 dark:border-orange-700 pl-2">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-orange-600 dark:text-orange-400 mb-1 flex items-center gap-1">
                      <ArrowRight className="h-3 w-3" /> Dependencies
                    </div>
                    {viewedBead.dependencies.blocked_by.length > 0 && (
                      <div className="mt-0.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Blocked by: </span>
                        {viewedBead.dependencies.blocked_by.map((dep, i) => (
                          <BeadRefHoverCard key={`bb-${dep}-${i}`} beadId={dep} beads={beads} onSelectBead={setViewingBeadId} />
                        ))}
                      </div>
                    )}
                    {viewedBead.dependencies.blocks.length > 0 && (
                      <div className="mt-0.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Blocks: </span>
                        {viewedBead.dependencies.blocks.map((dep, i) => (
                          <BeadRefHoverCard key={`bl-${dep}-${i}`} beadId={dep} beads={beads} onSelectBead={setViewingBeadId} />
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Target Files */}
                {viewedBead.targetFiles.length > 0 && (
                  <div className="border-l-2 border-cyan-300 dark:border-cyan-700 pl-2">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-cyan-600 dark:text-cyan-400 mb-1 flex items-center gap-1">
                      <FileCode2 className="h-3 w-3" /> Target Files
                    </div>
                    <div className="space-y-0.5">
                      {viewedBead.targetFiles.map((file, i) => (
                        <TargetFileRow key={`file-${file}-${i}`} file={file} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Context Guidance */}
                {(viewedBead.contextGuidance.patterns.length > 0 || viewedBead.contextGuidance.anti_patterns.length > 0) && (
                  <div className="border-l-2 border-violet-300 dark:border-violet-700 pl-2">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-violet-600 dark:text-violet-400 mb-1">Context Guidance</div>
                    {viewedBead.contextGuidance.patterns.length > 0 && (
                      <div className="mt-1">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">Patterns</div>
                        <ul className="text-xs space-y-0.5 pl-3">
                          {viewedBead.contextGuidance.patterns.map((pattern) => (
                            <li key={pattern}>- {pattern}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {viewedBead.contextGuidance.anti_patterns.length > 0 && (
                      <div className="mt-1">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">Anti-patterns</div>
                        <ul className="text-xs space-y-0.5 pl-3">
                          {viewedBead.contextGuidance.anti_patterns.map((ap) => (
                            <li key={ap}>- {ap}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {/* Acceptance Criteria */}
                {viewedBead.acceptanceCriteria.length > 0 && (
                  <div className="border-l-2 border-green-300 dark:border-green-700 pl-2">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-green-600 dark:text-green-400 mb-1">Acceptance Criteria</div>
                    <ul className="text-xs space-y-1">
                      {viewedBead.acceptanceCriteria.map((criterion) => (
                        <li key={criterion}>- {criterion}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Tests */}
                {(viewedBead.tests.length > 0 || viewedBead.testCommands.length > 0 || viewedBead.testCommandReason) && (
                  <div className="border-l-2 border-amber-300 dark:border-amber-700 pl-2 space-y-1.5">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-amber-600 dark:text-amber-400">Tests</div>
                    {viewedBead.tests.length > 0 && (
                      <ul className="text-xs space-y-1">
                        {viewedBead.tests.map((test) => (
                          <li key={test}>- {test}</li>
                        ))}
                      </ul>
                    )}
                    {viewedBead.testCommands.length > 0 && (
                      <div>
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">Planned Test Commands</div>
                        <div className="space-y-1">
                          {viewedBead.testCommands.map((command, index) => (
                            <code key={index} className="block text-xs rounded bg-background border border-border px-2 py-1 font-mono">{renderCommandSpec(command)}</code>
                          ))}
                        </div>
                      </div>
                    )}
                    {viewedBead.testCommands.length === 0 && viewedBead.testCommandReason && (
                      <div>
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">No Planned Automated Command</div>
                        <p className="text-xs text-muted-foreground">{viewedBead.testCommandReason}</p>
                      </div>
                    )}
                  </div>
                )}

                <BeadNoteHistory title="Failed Iteration Notes" notes={viewedBead.failedIterationNotes} tone="rose" />
                <BeadNoteHistory title="User Retry Notes" notes={viewedBead.userRetryNotes} tone="violet" />
                <BeadNoteHistory title="Finalization Failure Notes" notes={viewedBead.finalizationFailureNotes} tone="amber" />
              </div>
            )}
          </div>
        ) : (
          <CollapsiblePhaseLogSection phase={phaseForView} phaseAttempt={logPhaseAttempt} logMode={logMode} ticket={ticket} />
        )}
      </div>
    </div>
  )
}
