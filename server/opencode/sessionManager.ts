import { and, eq, isNull } from 'drizzle-orm'
import { opencodeSessions, tickets } from '../db/schema'
import type { OpenCodeAdapter } from './adapter'
import type { OpenCodeSessionCreateOptions, Session } from './types'
import { getOpenCodeAdapter } from './factory'
import { getProjectContextById, listProjects } from '../storage/projects'
import { buildTicketRef, getTicketByRef, getTicketContext } from '../storage/tickets'
import { emitOpenCodeSessionEnded } from './sessionEvents'
import { createOpenCodeSessionWithRetry } from './sessionCreation'
import {
  getPendingSessionContinuationForTicketPhase,
  isContinuableBlockedError,
} from './sessionContinuation'
import type { WorkflowPhaseId } from '@shared/workflowMeta'

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

export function listOpenCodeSessionsForTicket(ticketId: string, states: string[] = ['active']): OpenCodeSessionRecord[] {
  const context = getTicketContext(ticketId)
  if (!context) return []
  return context.projectDb
    .select()
    .from(opencodeSessions)
    .where(eq(opencodeSessions.ticketId, context.localTicketId))
    .all()
    .filter((session) => states.length === 0 || states.includes(session.state))
}

export function reactivateOpenCodeSessionForContinuation(
  ticketId: string,
  phase: WorkflowPhaseId,
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

    const session = await createOpenCodeSessionWithRetry(
      this.adapter,
      projectPath ?? context.projectRoot,
      signal,
      createOptions,
    )

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

    return session
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
  }

  async abandonSession(sessionId: string) {
    const found = findSessionRecord(sessionId)
    if (!found) return
    found.projectDb.update(opencodeSessions)
      .set({ state: 'abandoned', updatedAt: new Date().toISOString() })
      .where(eq(opencodeSessions.sessionId, sessionId))
      .run()
    // A question window that outlives its session would later reject a request
    // OpenCode no longer has, and its suspended work budget would hold the next
    // run's clocks still.
    emitOpenCodeSessionEnded({
      sessionId,
      ticketId: resolveSessionTicketRef(found),
      reason: 'abandoned',
    })
  }

  getActiveSession(ticketId: string, phase: WorkflowPhaseId, memberId?: string) {
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

  getOwnedActiveSession(ticketId: string, phase: WorkflowPhaseId, ownership: SessionOwnership) {
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
    phase: WorkflowPhaseId,
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
    return null
  }

  private getActiveSessionById(ticketId: string, phase: WorkflowPhaseId, sessionId: string) {
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
    phase: WorkflowPhaseId,
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

export async function abortTicketSessions(ticketId: string): Promise<void> {
  const context = getTicketContext(ticketId)
  if (!context) return

  const activeSessions = context.projectDb
    .select()
    .from(opencodeSessions)
    .where(and(eq(opencodeSessions.ticketId, context.localTicketId), eq(opencodeSessions.state, 'active')))
    .all()

  if (activeSessions.length === 0) return

  const adapter = getOpenCodeAdapter()

  await Promise.allSettled(
    activeSessions.map(async (session: typeof opencodeSessions.$inferSelect) => {
      try {
        await adapter.abortSession(session.sessionId)
      } catch (err) {
        console.warn(`[sessionManager] Failed to abort OpenCode session ${session.sessionId}:`, err)
      } finally {
        context.projectDb.update(opencodeSessions)
          .set({ state: 'abandoned', updatedAt: new Date().toISOString() })
          .where(eq(opencodeSessions.id, session.id))
          .run()
        emitOpenCodeSessionEnded({ sessionId: session.sessionId, ticketId, reason: 'aborted' })
      }
    }),
  )

  console.log(`[sessionManager] Aborted ${activeSessions.length} active session(s) for ticket ${ticketId}`)
}
