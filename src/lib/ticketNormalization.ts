import type { Ticket } from '@/hooks/useTickets'

type TicketRuntime = Ticket['runtime']

const DEFAULT_TICKET_RUNTIME: TicketRuntime = {
  baseBranch: 'unknown',
  currentBead: 0,
  completedBeads: 0,
  totalBeads: 0,
  percentComplete: 0,
  iterationCount: 0,
  maxIterations: null,
  maxIterationsPerBead: null,
  perIterationTimeoutMs: null,
  executionSetupTimeoutMs: null,
  activeBeadId: null,
  activeBeadIteration: null,
  lastFailedBeadId: null,
  artifactRoot: '',
  beads: [],
  candidateCommitSha: null,
  preSquashHead: null,
  finalTestStatus: 'pending',
  prNumber: null,
  prUrl: null,
  prState: null,
  prHeadSha: null,
  eta: null,
}

const DEFAULT_CLEANUP_SUMMARY: NonNullable<Ticket['cleanup']> = {
  status: null,
  errorCount: 0,
  latestReportArtifactId: null,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function numberOrFallback(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeBeadNoteEntries(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) => ({
      timestamp: stringOrFallback(entry.timestamp, ''),
      iteration: numberOrFallback(entry.iteration, 0),
      content: stringOrFallback(entry.content, ''),
      ...(typeof entry.errorCode === 'string' ? { errorCode: entry.errorCode } : {}),
    }))
    .filter((entry) => entry.content.trim().length > 0)
}

function normalizeRuntimeBeads(value: unknown): TicketRuntime['beads'] {
  if (!Array.isArray(value)) return []
  return value
    .filter((bead): bead is Record<string, unknown> => isRecord(bead))
    .map((bead) => ({
      id: stringOrFallback(bead.id, ''),
      title: stringOrFallback(bead.title, 'Untitled'),
      status: stringOrFallback(bead.status, 'pending'),
      iteration: numberOrFallback(bead.iteration, 0),
      failedIterationNotes: normalizeBeadNoteEntries(bead.failedIterationNotes),
      userRetryNotes: normalizeBeadNoteEntries(bead.userRetryNotes),
      finalizationFailureNotes: normalizeBeadNoteEntries(bead.finalizationFailureNotes),
      startedAt: typeof bead.startedAt === 'string' ? bead.startedAt : null,
      updatedAt: typeof bead.updatedAt === 'string' ? bead.updatedAt : null,
    }))
    .filter((bead) => bead.id.length > 0)
}

function normalizeRuntimeEta(value: unknown): TicketRuntime['eta'] {
  if (!isRecord(value)) return null
  const bestMs = nullableNumber(value.bestMs)
  const likelyMs = nullableNumber(value.likelyMs)
  const worstMs = nullableNumber(value.worstMs)
  const basis = value.basis
  if (bestMs === null || likelyMs === null || worstMs === null) return null
  if (basis !== 'history' && basis !== 'current' && basis !== 'default') return null
  return { bestMs, likelyMs, worstMs, basis }
}

export function getTicketRuntime(ticket: Ticket): TicketRuntime {
  const rawTicket = ticket as unknown as Record<string, unknown>
  const rawRuntime: Record<string, unknown> = isRecord(rawTicket.runtime)
    ? rawTicket.runtime
    : {}
  const fallbackCurrentBead = numberOrFallback(rawTicket.currentBead, DEFAULT_TICKET_RUNTIME.currentBead)
  const fallbackTotalBeads = numberOrFallback(rawTicket.totalBeads, DEFAULT_TICKET_RUNTIME.totalBeads)
  const fallbackPercentComplete = numberOrFallback(
    rawTicket.percentComplete,
    DEFAULT_TICKET_RUNTIME.percentComplete,
  )

  return {
    baseBranch: stringOrFallback(rawRuntime.baseBranch, DEFAULT_TICKET_RUNTIME.baseBranch),
    currentBead: numberOrFallback(rawRuntime.currentBead, fallbackCurrentBead),
    completedBeads: numberOrFallback(rawRuntime.completedBeads, DEFAULT_TICKET_RUNTIME.completedBeads),
    totalBeads: numberOrFallback(rawRuntime.totalBeads, fallbackTotalBeads),
    percentComplete: numberOrFallback(rawRuntime.percentComplete, fallbackPercentComplete),
    iterationCount: numberOrFallback(rawRuntime.iterationCount, DEFAULT_TICKET_RUNTIME.iterationCount),
    maxIterations: nullableNumber(rawRuntime.maxIterations),
    maxIterationsPerBead: nullableNumber(rawRuntime.maxIterationsPerBead),
    perIterationTimeoutMs: nullableNumber(rawRuntime.perIterationTimeoutMs),
    executionSetupTimeoutMs: nullableNumber(rawRuntime.executionSetupTimeoutMs),
    activeBeadId: nullableString(rawRuntime.activeBeadId),
    activeBeadIteration: nullableNumber(rawRuntime.activeBeadIteration),
    lastFailedBeadId: nullableString(rawRuntime.lastFailedBeadId),
    artifactRoot: stringOrFallback(rawRuntime.artifactRoot, DEFAULT_TICKET_RUNTIME.artifactRoot),
    beads: normalizeRuntimeBeads(rawRuntime.beads),
    candidateCommitSha: nullableString(rawRuntime.candidateCommitSha),
    preSquashHead: nullableString(rawRuntime.preSquashHead),
    finalTestStatus: rawRuntime.finalTestStatus === 'passed' || rawRuntime.finalTestStatus === 'failed'
      ? rawRuntime.finalTestStatus
      : DEFAULT_TICKET_RUNTIME.finalTestStatus,
    prNumber: nullableNumber(rawRuntime.prNumber),
    prUrl: nullableString(rawRuntime.prUrl),
    prState: rawRuntime.prState === 'draft'
      || rawRuntime.prState === 'open'
      || rawRuntime.prState === 'merged'
      || rawRuntime.prState === 'closed'
      ? rawRuntime.prState
      : null,
    prHeadSha: nullableString(rawRuntime.prHeadSha),
    eta: normalizeRuntimeEta(rawRuntime.eta),
  }
}

export function getTicketCouncilMembers(ticket: Ticket): string[] {
  const rawMembers = (ticket as unknown as Record<string, unknown>).lockedCouncilMembers
  if (!Array.isArray(rawMembers)) return []
  return rawMembers.filter((memberId): memberId is string => typeof memberId === 'string' && memberId.trim().length > 0)
}

export function getTicketAvailableActions(ticket: Ticket): Ticket['availableActions'] {
  const rawActions = (ticket as unknown as Record<string, unknown>).availableActions
  if (!Array.isArray(rawActions)) return []
  return rawActions.filter((action): action is string => typeof action === 'string' && action.trim().length > 0) as Ticket['availableActions']
}

export function normalizeTicketForRender(ticket: Ticket): Ticket {
  const cleanup = isRecord((ticket as unknown as Record<string, unknown>).cleanup)
    ? (ticket as unknown as { cleanup?: Ticket['cleanup'] }).cleanup
    : null
  return {
    ...ticket,
    runtime: getTicketRuntime(ticket),
    lockedCouncilMembers: getTicketCouncilMembers(ticket),
    availableActions: getTicketAvailableActions(ticket),
    cleanup: {
      status: cleanup?.status === 'clean' || cleanup?.status === 'warning' ? cleanup.status : null,
      errorCount: numberOrFallback(cleanup?.errorCount, DEFAULT_CLEANUP_SUMMARY.errorCount),
      latestReportArtifactId: nullableNumber(cleanup?.latestReportArtifactId),
      errors: Array.isArray(cleanup?.errors) ? cleanup.errors.filter((e): e is string => typeof e === 'string') : [],
    },
  }
}
