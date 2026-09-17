import { rmSync } from 'node:fs'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { opencodeSessions, tickets } from '../db/schema'
import type { OpenCodeAdapter } from './adapter'
import type { OpenCodeSessionCreateOptions, Session } from './types'
import { getOpenCodeAdapter } from './factory'
import { getProjectContextById, listProjects } from '../storage/projects'
import { getExistingProjectDatabase } from '../db/project'
import { buildTicketRef, getTicketByRef, getTicketContext } from '../storage/tickets'
import { readTicketFile, resolveTicketContainedPath, writeTicketFile } from '../storage/ticketQueries'
import { emitOpenCodeSessionEnded } from './sessionEvents'
import { createOpenCodeSessionWithRetry } from './sessionCreation'
import {
  clearTicketSessionContinuations,
  clearSessionContinuation,
  getPendingSessionContinuationForTicketPhase,
  isContinuableBlockedError,
} from './sessionContinuation'
import type { WorkflowPhaseId } from '@shared/workflowMeta'

const PENDING_SESSION_OWNERSHIP_ARTIFACT = 'runtime/opencode-pending-sessions.json'

interface PendingSessionOwnershipRecord {
  sessionId: string
  phase: string
  phaseAttempt: number
  memberId: string | null
  beadId: string | null
  iteration: number | null
  step: string | null
}

interface PendingSessionOwnershipRead {
  records: PendingSessionOwnershipRecord[]
  readable: boolean
}

// This map is only a fail-closed guard for the exceptional case where both
// SQLite and the ticket's atomic marker are unavailable. It is deliberately
// not used as ownership recovery: a restart cannot discover these entries.
const unpersistedSessionOwnership = new Map<string, Set<string>>()

// A remote create has to stay in the ticket's cleanup accounting before it
// has returned a session id. Otherwise a cancellation can observe no row and
// no marker while that create is still able to publish a new remote session.
const pendingSessionCreations = new Map<string, number>()

function beginSessionCreation(ticketId: string): void {
  pendingSessionCreations.set(ticketId, (pendingSessionCreations.get(ticketId) ?? 0) + 1)
}

function endSessionCreation(ticketId: string): void {
  const remaining = (pendingSessionCreations.get(ticketId) ?? 1) - 1
  if (remaining > 0) pendingSessionCreations.set(ticketId, remaining)
  else pendingSessionCreations.delete(ticketId)
}

function countPendingSessionCreations(ticketId: string): number {
  return pendingSessionCreations.get(ticketId) ?? 0
}

function canonicalOwnershipTicketId(
  context: NonNullable<ReturnType<typeof getTicketContext>>,
): string {
  return buildTicketRef(context.projectId, context.localTicket.externalId)
}

export interface SessionOwnership {
  ticketId?: string
  phaseAttempt?: number
  memberId?: string | null
  beadId?: string | null
  iteration?: number | null
  step?: string | null
}

export type OpenCodeSessionRecord = typeof opencodeSessions.$inferSelect

export type SessionReconnectResult =
  | { state: 'reconnected'; session: Session }
  | { state: 'stale' | 'missing' | 'unverified' }

function findSessionRecord(sessionId: string) {
  for (const project of listProjects()) {
    const context = getProjectContextById(project.id)
    if (!context) continue
    const record = context.projectDb.select().from(opencodeSessions)
      .where(eq(opencodeSessions.sessionId, sessionId))
      .get()
    if (record) {
      return { projectDb: context.projectDb, record, projectId: project.id }
    }
  }
  return null
}

/** The composite ref for a session's ticket, or undefined if it owned none. */
function resolveSessionTicketRef(found: NonNullable<ReturnType<typeof findSessionRecord>>): string | undefined {
  if (found.record.ticketId == null) return undefined
  const owner = found.projectDb.select({ externalId: tickets.externalId })
    .from(tickets)
    .where(eq(tickets.id, found.record.ticketId))
    .get()
  return owner ? buildTicketRef(found.projectId, owner.externalId) : undefined
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function readPendingSessionOwnership(ticketId: string): PendingSessionOwnershipRead {
  let raw: string | null
  try {
    raw = readTicketFile(ticketId, PENDING_SESSION_OWNERSHIP_ARTIFACT)
  } catch (error) {
    console.warn(`[sessionManager] Could not read pending ownership for ticket ${ticketId}:`, error)
    return { records: [], readable: false }
  }
  if (raw === null) return { records: [], readable: true }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('pending ownership must be an array')
    const records = parsed.map((candidate): PendingSessionOwnershipRecord => {
      if (typeof candidate !== 'object' || candidate === null) throw new Error('pending ownership entry must be an object')
      const record = candidate as Record<string, unknown>
      if (
        typeof record.sessionId !== 'string' || record.sessionId.trim() === ''
        || typeof record.phase !== 'string' || record.phase.trim() === ''
        || typeof record.phaseAttempt !== 'number' || !Number.isInteger(record.phaseAttempt) || record.phaseAttempt < 1
        || !isNullableString(record.memberId)
        || !isNullableString(record.beadId)
        || !isNullableString(record.step)
        || (record.iteration !== null
          && (typeof record.iteration !== 'number' || !Number.isInteger(record.iteration)))
      ) {
        throw new Error('pending ownership entry has invalid fields')
      }
      return {
        sessionId: record.sessionId,
        phase: record.phase,
        phaseAttempt: record.phaseAttempt,
        memberId: record.memberId,
        beadId: record.beadId,
        iteration: record.iteration as number | null,
        step: record.step,
      }
    })
    return { records, readable: true }
  } catch (error) {
    console.warn(`[sessionManager] Could not parse pending ownership for ticket ${ticketId}:`, error)
    return { records: [], readable: false }
  }
}

function writePendingSessionOwnership(ticketId: string, records: PendingSessionOwnershipRecord[]): boolean {
  try {
    if (records.length === 0) {
      const path = resolveTicketContainedPath(ticketId, PENDING_SESSION_OWNERSHIP_ARTIFACT, 'remove')
      if (!path) return false
      rmSync(path, { force: true })
      return true
    }
    writeTicketFile(ticketId, PENDING_SESSION_OWNERSHIP_ARTIFACT, `${JSON.stringify(records, null, 2)}\n`)
    return true
  } catch (error) {
    console.warn(`[sessionManager] Could not write pending ownership for ticket ${ticketId}:`, error)
    return false
  }
}

function rememberPendingSessionOwnership(ticketId: string, record: PendingSessionOwnershipRecord): boolean {
  const current = readPendingSessionOwnership(ticketId)
  if (!current.readable) return false
  if (current.records.some(candidate => candidate.sessionId === record.sessionId)) return true
  return writePendingSessionOwnership(ticketId, [...current.records, record])
}

function forgetPendingSessionOwnership(ticketId: string, sessionId: string): boolean {
  const current = readPendingSessionOwnership(ticketId)
  if (!current.readable) return false
  const remaining = current.records.filter(record => record.sessionId !== sessionId)
  if (remaining.length === current.records.length) return true
  return writePendingSessionOwnership(ticketId, remaining)
}

function markUnpersistedSessionOwnership(ticketId: string, sessionId: string): void {
  const sessions = unpersistedSessionOwnership.get(ticketId) ?? new Set<string>()
  sessions.add(sessionId)
  unpersistedSessionOwnership.set(ticketId, sessions)
}

function clearUnpersistedSessionOwnership(ticketId: string, sessionId: string): void {
  const sessions = unpersistedSessionOwnership.get(ticketId)
  if (!sessions) return
  sessions.delete(sessionId)
  if (sessions.size === 0) unpersistedSessionOwnership.delete(ticketId)
}

function listUnpersistedSessionOwnership(ticketId: string): string[] {
  return [...(unpersistedSessionOwnership.get(ticketId) ?? [])]
}

function hasCurrentSessionOwnership(
  ticketId: string,
  context: NonNullable<ReturnType<typeof getTicketContext>>,
): boolean {
  const activeRows = context.projectDb
    .select({ sessionId: opencodeSessions.sessionId })
    .from(opencodeSessions)
    .where(and(eq(opencodeSessions.ticketId, context.localTicketId), eq(opencodeSessions.state, 'active')))
    .all()
  const pending = readPendingSessionOwnership(ticketId)
  return activeRows.length > 0
    || !pending.readable
    || pending.records.length > 0
    || listUnpersistedSessionOwnership(ticketId).length > 0
    || countPendingSessionCreations(ticketId) > 0
}

/**
 * Keep remote ownership discoverable when the normal Drizzle insert itself
 * failed. The project database is already the restart source of truth, so a
 * direct SQLite retry is deliberately limited to the same existing table — it
 * does not introduce a memory-only pending-session registry.
 */
function persistSessionOwnershipFallback(input: {
  projectRoot: string
  ticketId: number
  sessionId: string
  phase: WorkflowPhaseId
  phaseAttempt: number
  memberId: string | null
  beadId: string | null
  iteration: number | null
  step: string | null
}): boolean {
  try {
    const projectDatabase = getExistingProjectDatabase(input.projectRoot)
    if (!projectDatabase) return false
    const existing = projectDatabase.sqlite.prepare(
      `SELECT id
         FROM opencode_sessions
        WHERE session_id = ?
          AND ticket_id = ?
          AND state = 'active'
        LIMIT 1`,
    ).get(input.sessionId, input.ticketId)
    if (existing) return true

    projectDatabase.sqlite.prepare(
      `INSERT INTO opencode_sessions
        (session_id, ticket_id, phase, phase_attempt, member_id, bead_id, iteration, step, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    ).run(
      input.sessionId,
      input.ticketId,
      input.phase,
      input.phaseAttempt,
      input.memberId,
      input.beadId,
      input.iteration,
      input.step,
    )
    return true
  } catch (fallbackError) {
    console.warn(`[sessionManager] Could not persist fallback ownership for OpenCode session ${input.sessionId}:`, fallbackError)
    return false
  }
}

function persistPendingSessionOwnershipFallback(input: {
  ticketId: string
  sessionId: string
  phase: WorkflowPhaseId
  phaseAttempt: number
  memberId: string | null
  beadId: string | null
  iteration: number | null
  step: string | null
}): boolean {
  return rememberPendingSessionOwnership(input.ticketId, {
    sessionId: input.sessionId,
    phase: input.phase,
    phaseAttempt: input.phaseAttempt,
    memberId: input.memberId,
    beadId: input.beadId,
    iteration: input.iteration,
    step: input.step,
  })
}

/**
 * Replays the filesystem ownership marker into the project database after a
 * restart. The marker stays in place until every row is durable, so a
 * read-only or otherwise unavailable database cannot turn an owned remote
 * session into an untracked one.
 */
export function recoverPendingOpenCodeSessionOwnership(ticketId: string): boolean {
  const context = getTicketContext(ticketId)
  if (!context) return false
  const ownershipTicketId = canonicalOwnershipTicketId(context)
  const pending = readPendingSessionOwnership(ownershipTicketId)
  if (!pending.readable) return false
  if (pending.records.length === 0) return true

  try {
    for (const record of pending.records) {
      const existing = context.projectDb
        .select({ id: opencodeSessions.id })
        .from(opencodeSessions)
        .where(and(
          eq(opencodeSessions.ticketId, context.localTicketId),
          eq(opencodeSessions.sessionId, record.sessionId),
        ))
        .get()
      if (!existing) {
        context.projectDb.insert(opencodeSessions)
          .values({
            sessionId: record.sessionId,
            ticketId: context.localTicketId,
            phase: record.phase,
            phaseAttempt: record.phaseAttempt,
            memberId: record.memberId,
            beadId: record.beadId,
            iteration: record.iteration,
            step: record.step,
            state: 'active',
          })
          .run()
      }
    }
  } catch (error) {
    console.warn(`[sessionManager] Could not recover pending OpenCode ownership for ticket ${ticketId}:`, error)
    return false
  }

  if (!writePendingSessionOwnership(ownershipTicketId, [])) return false
  for (const record of pending.records) clearUnpersistedSessionOwnership(ownershipTicketId, record.sessionId)
  return true
}

export function listOpenCodeSessionsForTicket(ticketId: string, states: string[] = ['active']): OpenCodeSessionRecord[] {
  const context = getTicketContext(ticketId)
  if (!context) return []
  // Filtered by the database rather than in JavaScript: every session row a
  // ticket ever had was selected and most were then thrown away.
  return context.projectDb
    .select()
    .from(opencodeSessions)
    .where(states.length > 0
      ? and(eq(opencodeSessions.ticketId, context.localTicketId), inArray(opencodeSessions.state, states))
      : eq(opencodeSessions.ticketId, context.localTicketId))
    .all()
}

/**
 * A phase used to look a session row up, as that row stores it.
 *
 * Deliberately not `WorkflowPhaseId`. These are query keys against rows this
 * process did not necessarily write, and narrowing one means running an
 * unrecognised value through a fallback before the lookup — which changes the
 * key, finds nothing, and abandons a session that is still alive. Session
 * *creation* below is a write and does take `WorkflowPhaseId`.
 */
type StoredSessionPhase = string

export function reactivateOpenCodeSessionForContinuation(
  ticketId: string,
  phase: StoredSessionPhase,
  sessionId: string,
): boolean {
  const context = getTicketContext(ticketId)
  if (!context) return false
  const result = context.projectDb.update(opencodeSessions)
    .set({ state: 'active', updatedAt: new Date().toISOString() })
    .where(and(
      eq(opencodeSessions.ticketId, context.localTicketId),
      eq(opencodeSessions.phase, phase),
      eq(opencodeSessions.sessionId, sessionId),
    ))
    .run()
  return result.changes > 0
}

export class SessionManager {
  constructor(private adapter: OpenCodeAdapter) {}

  async createSessionForPhase(
    ticketId: string,
    phase: WorkflowPhaseId,
    phaseAttempt: number,
    memberId?: string,
    beadId?: string,
    iteration?: number,
    step?: string,
    projectPath?: string,
    createOptions?: OpenCodeSessionCreateOptions,
    signal?: AbortSignal,
  ): Promise<Session> {
    const context = getTicketContext(ticketId)
    if (!context) throw new Error(`Ticket not found: ${ticketId}`)
    const ownershipTicketId = canonicalOwnershipTicketId(context)

    beginSessionCreation(ownershipTicketId)
    try {
      const session = await createOpenCodeSessionWithRetry(
        this.adapter,
        projectPath ?? context.projectRoot,
        signal,
        createOptions,
      )

    try {
      context.projectDb.insert(opencodeSessions)
        .values({
          sessionId: session.id,
          ticketId: context.localTicketId,
          phase,
          phaseAttempt,
          memberId: memberId ?? null,
          beadId: beadId ?? null,
          iteration: iteration ?? null,
          step: step ?? null,
          state: 'active',
        })
        .run()
    } catch (error) {
      // The remote session exists before its local ownership row. If the row
      // cannot be written through Drizzle, retry the same durable table through
      // the already-open project connection before stopping the remote object.
      // A failed confirmation then remains visible to startup and ticket
      // cleanup rather than disappearing into process memory.
      const ownershipPersisted = persistSessionOwnershipFallback({
        projectRoot: context.projectRoot,
        ticketId: context.localTicketId,
        sessionId: session.id,
        phase,
        phaseAttempt,
        memberId: memberId ?? null,
        beadId: beadId ?? null,
        iteration: iteration ?? null,
        step: step ?? null,
      })
      if (!ownershipPersisted) {
        const pendingOwnershipPersisted = persistPendingSessionOwnershipFallback({
          ticketId: ownershipTicketId,
          sessionId: session.id,
          phase,
          phaseAttempt,
          memberId: memberId ?? null,
          beadId: beadId ?? null,
          iteration: iteration ?? null,
          step: step ?? null,
        })
        if (!pendingOwnershipPersisted) {
          markUnpersistedSessionOwnership(ownershipTicketId, session.id)
          console.warn(
            `[sessionManager] OpenCode session ${session.id} has no durable ownership; `
            + 'cleanup will fail closed in this process, but a restart cannot discover it',
          )
        }
      }
      try {
        const stopped = await this.adapter.abortSession(session.id)
        if (!stopped) {
          console.warn(`[sessionManager] Could not confirm cleanup for untracked OpenCode session ${session.id}`)
        } else {
          if (ownershipPersisted) {
            try {
              const update = context.projectDb.update(opencodeSessions)
                .set({ state: 'abandoned', updatedAt: new Date().toISOString() })
                .where(and(
                  eq(opencodeSessions.ticketId, context.localTicketId),
                  eq(opencodeSessions.sessionId, session.id),
                  eq(opencodeSessions.state, 'active'),
                ))
                .run()
              if (update.changes > 0) {
                emitOpenCodeSessionEnded({ sessionId: session.id, ticketId, reason: 'aborted' })
                clearSessionContinuation(session.id)
              }
            } catch (recordError) {
              console.warn(`[sessionManager] Failed to reconcile stopped OpenCode session ${session.id}:`, recordError)
            }
          } else {
              forgetPendingSessionOwnership(ownershipTicketId, session.id)
              clearUnpersistedSessionOwnership(ownershipTicketId, session.id)
          }
          this.adapter.forgetSessionDirectory?.(session.id)
        }
      } catch (cleanupError) {
        console.warn(`[sessionManager] Failed to clean up untracked OpenCode session ${session.id}:`, cleanupError)
      }
      throw error
    }

      return session
    } finally {
      endSessionCreation(ownershipTicketId)
    }
  }

  createSessionForOwnership(
    ticketId: string,
    phase: WorkflowPhaseId,
    ownership: SessionOwnership,
    projectPath?: string,
    createOptions?: OpenCodeSessionCreateOptions,
    signal?: AbortSignal,
  ): Promise<Session> {
    return this.createSessionForPhase(
      ticketId,
      phase,
      ownership.phaseAttempt ?? 1,
      ownership.memberId ?? undefined,
      ownership.beadId ?? undefined,
      ownership.iteration ?? undefined,
      ownership.step ?? undefined,
      projectPath,
      createOptions,
      signal,
    )
  }

  async completeSession(sessionId: string) {
    const found = findSessionRecord(sessionId)
    if (!found) return
    found.projectDb.update(opencodeSessions)
      .set({ state: 'completed', updatedAt: new Date().toISOString() })
      .where(eq(opencodeSessions.sessionId, sessionId))
      .run()
    const ticketRef = resolveSessionTicketRef(found)
    if (ticketRef) forgetPendingSessionOwnership(ticketRef, sessionId)
    this.adapter.forgetSessionDirectory?.(sessionId)
  }

  async abandonSession(sessionId: string) {
    const found = findSessionRecord(sessionId)
    if (!found) return
    found.projectDb.update(opencodeSessions)
      .set({ state: 'abandoned', updatedAt: new Date().toISOString() })
      .where(eq(opencodeSessions.sessionId, sessionId))
      .run()
    const ticketRef = resolveSessionTicketRef(found)
    if (ticketRef) forgetPendingSessionOwnership(ticketRef, sessionId)
    this.adapter.forgetSessionDirectory?.(sessionId)
    // A question window that outlives its session would later reject a request
    // OpenCode no longer has, and its suspended work budget would hold the next
    // run's clocks still.
    emitOpenCodeSessionEnded({
      sessionId,
      ticketId: resolveSessionTicketRef(found),
      reason: 'abandoned',
    })
  }

  /**
   * Stops a tracked remote session before abandoning its local ownership row.
   * A false result deliberately leaves the row active: callers that reset a
   * worktree or start a replacement must be able to withhold that work when
   * OpenCode did not confirm that the old session stopped.
   */
  async abortAndAbandonSession(sessionId: string): Promise<boolean> {
    const found = findSessionRecord(sessionId)
    if (found) {
      const current = found.projectDb.select({ state: opencodeSessions.state })
        .from(opencodeSessions)
        .where(eq(opencodeSessions.sessionId, sessionId))
        .get()
      if (current && current.state !== 'active') return true
    }

    let stopped = false
    try {
      stopped = await this.adapter.abortSession(sessionId)
    } catch (error) {
      console.warn(`[sessionManager] Failed to abort OpenCode session ${sessionId}:`, error)
    }
    if (!stopped) return false

    await this.abandonSession(sessionId)
    return true
  }

  getActiveSession(ticketId: string, phase: StoredSessionPhase, memberId?: string) {
    const context = getTicketContext(ticketId)
    if (!context) return undefined
    const conditions = [
      eq(opencodeSessions.ticketId, context.localTicketId),
      eq(opencodeSessions.phase, phase),
      eq(opencodeSessions.state, 'active'),
    ]
    if (memberId) {
      conditions.push(eq(opencodeSessions.memberId, memberId))
    }
    return context.projectDb
      .select()
      .from(opencodeSessions)
      .where(and(...conditions))
      .get()
  }

  getOwnedActiveSession(ticketId: string, phase: StoredSessionPhase, ownership: SessionOwnership) {
    const context = getTicketContext(ticketId)
    if (!context) return undefined
    const conditions = [
      eq(opencodeSessions.ticketId, context.localTicketId),
      eq(opencodeSessions.phase, phase),
      eq(opencodeSessions.phaseAttempt, ownership.phaseAttempt ?? 1),
      eq(opencodeSessions.state, 'active'),
    ]
    if (ownership.memberId == null) {
      conditions.push(isNull(opencodeSessions.memberId))
    } else {
      conditions.push(eq(opencodeSessions.memberId, ownership.memberId))
    }
    if (ownership.beadId == null) {
      conditions.push(isNull(opencodeSessions.beadId))
    } else {
      conditions.push(eq(opencodeSessions.beadId, ownership.beadId))
    }
    if (ownership.iteration === undefined || ownership.iteration === null) {
      conditions.push(isNull(opencodeSessions.iteration))
    } else {
      conditions.push(eq(opencodeSessions.iteration, ownership.iteration))
    }
    if (ownership.step == null) {
      conditions.push(isNull(opencodeSessions.step))
    } else {
      conditions.push(eq(opencodeSessions.step, ownership.step))
    }
    return context.projectDb
      .select()
      .from(opencodeSessions)
      .where(and(...conditions))
      .get()
  }

  async validateAndReconnect(
    ticketId: string,
    phase: StoredSessionPhase,
    ownership?: SessionOwnership,
    signal?: AbortSignal,
  ): Promise<Session | null> {
    const pendingContinuation = getPendingSessionContinuationForTicketPhase(ticketId, phase)
    const pendingSession = pendingContinuation
      ? this.getActiveSessionById(ticketId, phase, pendingContinuation.sessionId)
      : undefined
    const existing = pendingSession ?? (ownership
      ? this.getOwnedActiveSession(ticketId, phase, ownership)
      : this.getActiveSession(ticketId, phase))
    if (!existing) return null

    const result = await this.reconcileActiveSession(
      ticketId,
      phase,
      existing.sessionId,
      ownership,
      signal,
    )
    if (result.state === 'reconnected') return result.session
    if (result.state === 'missing') await this.abandonSession(existing.sessionId)
    if (result.state === 'stale') {
      const stopped = await this.abortAndAbandonSession(existing.sessionId)
      if (!stopped) {
        throw new Error(`Could not confirm abort of stale OpenCode session ${existing.sessionId}`)
      }
    }
    if (result.state === 'unverified') {
      throw new Error(`Could not verify whether OpenCode session ${existing.sessionId} is still active`)
    }
    return null
  }

  private getActiveSessionById(ticketId: string, phase: StoredSessionPhase, sessionId: string) {
    const context = getTicketContext(ticketId)
    if (!context) return undefined
    return context.projectDb
      .select()
      .from(opencodeSessions)
      .where(and(
        eq(opencodeSessions.ticketId, context.localTicketId),
        eq(opencodeSessions.phase, phase),
        eq(opencodeSessions.sessionId, sessionId),
        eq(opencodeSessions.state, 'active'),
      ))
      .get()
  }

  /**
   * Verifies one exact active session without conflating a transient OpenCode
   * failure with a confirmed missing or stale session.
   */
  async reconcileActiveSession(
    ticketId: string,
    phase: StoredSessionPhase,
    sessionId: string,
    ownership?: SessionOwnership,
    signal?: AbortSignal,
  ): Promise<SessionReconnectResult> {
    const ticket = getTicketByRef(ticketId)
    if (!ticket) return { state: 'stale' }
    const pendingContinuation = getPendingSessionContinuationForTicketPhase(ticketId, phase)
    const isExactPendingContinuation = pendingContinuation?.sessionId === sessionId

    if (ticket.status !== phase) {
      const occurrence = ticket.errorOccurrences.find(
        candidate => candidate.id === ticket.activeErrorOccurrenceId,
      )
      if (!isExactPendingContinuation && (
        ticket.status !== 'BLOCKED_ERROR'
        || ticket.previousStatus !== phase
        || occurrence?.blockedFromStatus !== phase
        || occurrence.resolvedAt !== null
        || occurrence.diagnostics?.sessionId?.trim() !== sessionId
        || !isContinuableBlockedError({
          diagnostics: occurrence.diagnostics,
          errorCodes: occurrence.errorCodes,
        })
      )) {
        return { state: 'stale' }
      }
    }

    const pendingSession = pendingContinuation?.sessionId === sessionId
      ? this.getActiveSessionById(ticketId, phase, sessionId)
      : undefined
    const existing = pendingSession ?? (ownership
      ? this.getOwnedActiveSession(ticketId, phase, ownership)
      : this.getActiveSession(ticketId, phase))
    if (!existing || existing.sessionId !== sessionId) return { state: 'stale' }

    let found: Session | null
    try {
      found = await this.adapter.getSession(existing.sessionId, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      return { state: 'unverified' }
    }

    if (!found) return { state: 'missing' }

    return { state: 'reconnected', session: found }
  }
}

export async function abortTicketSessions(ticketId: string): Promise<boolean> {
  const context = getTicketContext(ticketId)
  if (!context) {
    console.warn(`[sessionManager] Could not resolve ticket ${ticketId}; refusing cleanup success`)
    return false
  }
  const ownershipTicketId = canonicalOwnershipTicketId(context)

  const activeSessions = context.projectDb
    .select()
    .from(opencodeSessions)
    .where(and(eq(opencodeSessions.ticketId, context.localTicketId), eq(opencodeSessions.state, 'active')))
    .all()
  const pendingCreationCount = countPendingSessionCreations(ownershipTicketId)
  const pendingOwnership = readPendingSessionOwnership(ownershipTicketId)
  const unpersistedSessionIds = listUnpersistedSessionOwnership(ownershipTicketId)
  const activeSessionIds = new Set(activeSessions.map(session => session.sessionId))
  const pendingSessions = pendingOwnership.records.filter(record => !activeSessionIds.has(record.sessionId))
  const pendingSessionIds = new Set(pendingOwnership.records.map(record => record.sessionId))
  const unpersistedOnlySessionIds = unpersistedSessionIds.filter(
    sessionId => !activeSessionIds.has(sessionId) && !pendingSessionIds.has(sessionId),
  )

  // Before the early return: a ticket whose sessions are already abandoned can
  // still hold pending continuations, and those are exactly what the next run
  // would reapply. An unreadable marker is also a live uncertainty, not an
  // empty list.
  if (
    activeSessions.length === 0
    && pendingOwnership.readable
    && pendingSessions.length === 0
    && unpersistedOnlySessionIds.length === 0
    && pendingCreationCount === 0
  ) {
    clearTicketSessionContinuations(ownershipTicketId)
    return true
  }

  const adapter = getOpenCodeAdapter()
  let confirmedAborts = 0
  let allConfirmed = pendingOwnership.readable
    && pendingCreationCount === 0
  if (!pendingOwnership.readable) {
    console.warn(`[sessionManager] Pending ownership for ticket ${ticketId} is unreadable; refusing cleanup success`)
  }
  if (unpersistedOnlySessionIds.length > 0) {
    console.warn(`[sessionManager] Ticket ${ticketId} has ownership that was not persisted; refusing cleanup success until this process confirms it`)
  }
  if (pendingCreationCount > 0) {
    console.warn(`[sessionManager] Ticket ${ticketId} has ${pendingCreationCount} OpenCode session creation(s) still in flight; refusing cleanup success`)
  }

  await Promise.allSettled(
    activeSessions.map(async (session: typeof opencodeSessions.$inferSelect) => {
      let stopped = false
      try {
        stopped = await adapter.abortSession(session.sessionId)
      } catch (err) {
        allConfirmed = false
        console.warn(`[sessionManager] Failed to abort OpenCode session ${session.sessionId}:`, err)
      }
      if (stopped) {
        confirmedAborts += 1
        try {
          const update = context.projectDb.update(opencodeSessions)
            .set({ state: 'abandoned', updatedAt: new Date().toISOString() })
            .where(and(eq(opencodeSessions.id, session.id), eq(opencodeSessions.state, 'active')))
            .run()
          if (update.changes > 0) {
            if (!forgetPendingSessionOwnership(ownershipTicketId, session.sessionId)) {
              allConfirmed = false
              console.warn(`[sessionManager] Could not clear pending ownership for aborted OpenCode session ${session.sessionId}`)
            }
            adapter.forgetSessionDirectory?.(session.sessionId)
            emitOpenCodeSessionEnded({ sessionId: session.sessionId, ticketId, reason: 'aborted' })
            clearSessionContinuation(session.sessionId)
          } else {
            allConfirmed = false
            console.warn(`[sessionManager] Could not record aborted OpenCode session ${session.sessionId}; retaining cleanup failure`)
          }
        } catch (error) {
          // Remote stop is confirmed, but the local ownership row could not be
          // reconciled. Report failure so destructive callers do not race a
          // still-tracked session and a later sweep can finish the row.
          allConfirmed = false
          console.warn(`[sessionManager] Failed to record aborted OpenCode session ${session.sessionId}:`, error)
        }
      } else {
        allConfirmed = false
        console.warn(`[sessionManager] Could not confirm abort for OpenCode session ${session.sessionId}; retaining its active row`)
      }
    }),
  )

  for (const pending of pendingSessions) {
    let stopped = false
    try {
      stopped = await adapter.abortSession(pending.sessionId)
    } catch (error) {
      console.warn(`[sessionManager] Failed to abort pending OpenCode session ${pending.sessionId}:`, error)
    }
    if (!stopped) {
      allConfirmed = false
      console.warn(`[sessionManager] Could not confirm abort for pending OpenCode session ${pending.sessionId}; retaining ownership marker`)
      continue
    }

    confirmedAborts += 1
    if (!forgetPendingSessionOwnership(ownershipTicketId, pending.sessionId)) {
      allConfirmed = false
      console.warn(`[sessionManager] Could not clear pending ownership for aborted OpenCode session ${pending.sessionId}`)
      continue
    }
    adapter.forgetSessionDirectory?.(pending.sessionId)
    emitOpenCodeSessionEnded({ sessionId: pending.sessionId, ticketId, reason: 'aborted' })
    clearSessionContinuation(pending.sessionId)
  }

  for (const sessionId of unpersistedOnlySessionIds) {
    let stopped = false
    try {
      stopped = await adapter.abortSession(sessionId)
    } catch (error) {
      console.warn(`[sessionManager] Failed to abort unpersisted OpenCode session ${sessionId}:`, error)
    }
    if (!stopped) {
      allConfirmed = false
      console.warn(`[sessionManager] Could not confirm abort for unpersisted OpenCode session ${sessionId}; retaining cleanup failure`)
      continue
    }

    confirmedAborts += 1
    clearUnpersistedSessionOwnership(ownershipTicketId, sessionId)
    adapter.forgetSessionDirectory?.(sessionId)
    emitOpenCodeSessionEnded({ sessionId, ticketId, reason: 'aborted' })
    clearSessionContinuation(sessionId)
  }

  // A stop can yield while another creation publishes its ownership. Re-read
  // all ticket-scoped sources after the awaited aborts; the check is the last
  // asynchronous boundary so no later snapshot can be mistaken for proof that
  // every managed session stopped.
  if (hasCurrentSessionOwnership(ownershipTicketId, context)) {
    console.warn(`[sessionManager] Ticket ${ticketId} gained or retained OpenCode ownership during cleanup; refusing cleanup success`)
    return false
  }

  if (confirmedAborts > 0) {
    console.log(`[sessionManager] Confirmed abort for ${confirmedAborts} session(s) for ticket ${ticketId}`)
  }
  return allConfirmed
}
