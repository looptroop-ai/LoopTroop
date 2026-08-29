import { eq, inArray } from 'drizzle-orm'
import { initializeDatabase } from './db/init'
import { startWalCheckpoint } from './db/index'
import { createIndexes } from './db/indexes'
import { initPromptTemplates } from './prompts/templateStore'
import { hydrateAllTickets } from './machines/persistence'
import { getOpenCodeAdapter } from './opencode/factory'
import { SessionManager } from './opencode/sessionManager'
import { opencodeSessions, tickets } from './db/schema'
import { getProjectContextById, listProjects } from './storage/projects'
import { buildTicketRef, getTicketPaths, listTickets } from './storage/tickets'
import {
  formatStartupStorageSummary,
  initializeStartupState,
} from './startupState'
import { fixTrailingLineCorruption, recoverOrphanTmpFiles } from './io/recovery'
import { rebuildTicketRuntimeProjections } from './storage/ticketRuntimeProjection'
import { getErrorMessage } from '@shared/typeGuards'
import { getPendingQuestionSummary, reconcilePendingQuestionsAfterRestart } from './workflow/questionWindows'
import { closeQuestionWait, listOpenQuestionWaitTicketIds } from './storage/questionWaits'
import { resolveAiQuestionSettings } from './workflow/phases/helpers'

export function recoverTicketRuntimeArtifacts() {
  let recoveredTmpFiles = 0
  let repairedExecutionLogs = 0

  for (const ticket of listTickets()) {
    const paths = getTicketPaths(ticket.id)
    if (!paths) continue

    recoveredTmpFiles += recoverOrphanTmpFiles(paths.ticketDir).length
    for (const logPath of [paths.executionLogPath, paths.debugLogPath, paths.aiLogPath]) {
      if (fixTrailingLineCorruption(logPath)) {
        repairedExecutionLogs += 1
      }
    }
  }

  const rebuiltProjections = rebuildTicketRuntimeProjections()
  return {
    recoveredTmpFiles,
    repairedExecutionLogs,
    rebuiltProjections,
  }
}

export async function reconcileOpenCodeSessions(
  adapter: ReturnType<typeof getOpenCodeAdapter>,
  attachedProjects = listProjects(),
): Promise<{ reconnected: number; abandoned: number; preserved: number }> {
  const sessionManager = new SessionManager(adapter)
  let reconnected = 0
  let abandoned = 0
  let preserved = 0

  for (const project of attachedProjects) {
    const context = getProjectContextById(project.id)
    if (!context) continue
    const activeDbSessions = context.projectDb
      .select()
      .from(opencodeSessions)
      .where(eq(opencodeSessions.state, 'active'))
      .all()

    for (const session of activeDbSessions) {
      // Ticket ids are only unique inside a project database. Resolve the
      // composite ref from the project currently being reconciled.
      const localTicket = session.ticketId != null
        ? context.projectDb.select({ externalId: tickets.externalId })
            .from(tickets)
            .where(eq(tickets.id, session.ticketId))
            .get()
        : undefined
      const ticketRef = localTicket ? buildTicketRef(project.id, localTicket.externalId) : undefined
      const result = ticketRef
        ? await sessionManager.reconcileActiveSession(ticketRef, session.phase, session.sessionId, {
            ...(session.phaseAttempt != null ? { phaseAttempt: session.phaseAttempt } : {}),
            memberId: session.memberId,
            beadId: session.beadId,
            ...(session.iteration != null ? { iteration: session.iteration } : {}),
            step: session.step,
          })
        : { state: 'stale' as const }

      if (result.state === 'reconnected' && result.session.id === session.sessionId) {
        reconnected++
        continue
      }

      if (result.state === 'unverified') {
        preserved++
        continue
      }

      context.projectDb.update(opencodeSessions)
        .set({ state: 'abandoned', updatedAt: new Date().toISOString() })
        .where(eq(opencodeSessions.id, session.id))
        .run()
      abandoned++
    }
  }

  return { reconnected, abandoned, preserved }
}

/**
 * Puts a clock back on every question the previous process left waiting.
 *
 * Sessions survive a restart, so a question can too — and a reconnected session
 * whose question has no timer is a permanent hang, the exact thing this feature
 * exists to prevent. Runs *after* session reconciliation, which has already
 * decided what came back: a request whose session reconnected is re-armed, and
 * one whose session did not is refused, because nothing will ever answer it.
 *
 * Enumerated once per *project*, because that is the scope OpenCode answers in.
 * Walking ticket by ticket meant each pass saw the whole project's pending
 * requests but only one ticket's sessions, so a sibling ticket's live question
 * looked ownerless and was rejected — and a ticket whose sessions had all been
 * abandoned was never visited at all, leaving its questions hanging in OpenCode
 * with no trail. One ownership map over the project fixes both.
 */
export async function reconcileOpenCodeQuestions(
  attachedProjects = listProjects(),
): Promise<{ reattached: number; rejected: number }> {
  let reattached = 0
  let rejected = 0

  for (const project of attachedProjects) {
    const context = getProjectContextById(project.id)
    if (!context) continue

    // Every session, not only the reconnected ones. `reconcileOpenCodeSessions`
    // has already marked the failures abandoned, so filtering to `active` here
    // would hide exactly the questions that most need attention — the ones whose
    // session is gone and which nothing will ever answer. They are refused, but
    // they can only be *recorded* if we still know which ticket they belonged to.
    const sessionRows = context.projectDb
      .select({
        sessionId: opencodeSessions.sessionId,
        ticketId: opencodeSessions.ticketId,
        memberId: opencodeSessions.memberId,
        phase: opencodeSessions.phase,
        phaseAttempt: opencodeSessions.phaseAttempt,
        state: opencodeSessions.state,
      })
      .from(opencodeSessions)
      .all()

    const externalIds = new Map(
      context.projectDb
        .select({ id: tickets.id, externalId: tickets.externalId })
        .from(tickets)
        .where(inArray(
          tickets.id,
          sessionRows.map((row) => row.ticketId).filter((id): id is number => id !== null),
        ))
        .all()
        .map((row) => [row.id, row.externalId] as const),
    )

    // Open waits can belong to a ticket with no sessions left at all, so the
    // sweep below cannot rely on the session-derived map.
    const allTicketExternalIds = new Map(
      context.projectDb
        .select({ id: tickets.id, externalId: tickets.externalId })
        .from(tickets)
        .all()
        .map((row) => [row.id, row.externalId] as const),
    )

    const owners = sessionRows.flatMap((row) => {
      const externalId = row.ticketId === null ? undefined : externalIds.get(row.ticketId)
      if (!externalId) return []
      return [{
        sessionId: row.sessionId,
        ticketId: buildTicketRef(project.id, externalId),
        memberId: row.memberId ?? null,
        phase: row.phase,
        phaseAttempt: row.phaseAttempt ?? 1,
        active: row.state === 'active',
      }]
    })

    try {
      const result = await reconcilePendingQuestionsAfterRestart({
        projectRoot: project.folderPath,
        owners,
        windowMsFor: (ticketId) => resolveAiQuestionSettings(ticketId).windowMs,
      })
      reattached += result.reattached
      rejected += result.rejected
    } catch (err) {
      console.warn(`[startup] Failed to reconcile AI questions for ${project.name}:`, err)
    }

    // A wait is opened by the process that saw the question and closed by the
    // one that saw it resolved. When a restart falls between the two, the row
    // stays open and reads as "still waiting" forever — subtracting the ticket's
    // entire remaining life from its active duration and from the ETA samples.
    // Anything the reconcile above did not put back on a clock is over, so it is
    // closed here. Closing at now rather than guessing an end during the
    // downtime: the daemon was not working either, and an open row is far worse
    // than a slightly long one.
    for (const localTicketId of listOpenQuestionWaitTicketIds(context.projectDb)) {
      const externalId = externalIds.get(localTicketId) ?? allTicketExternalIds.get(localTicketId)
      if (!externalId) continue
      const ticketRef = buildTicketRef(project.id, externalId)
      if (getPendingQuestionSummary(ticketRef)) continue
      closeQuestionWait(ticketRef, Date.now())
    }
  }

  return { reattached, rejected }
}

export async function startupSequence(): Promise<void> {
  console.log('[startup] Step 1: Initialize database')
  initializeDatabase()

  console.log('[startup] Step 1b: Create indexes')
  createIndexes()

  const startupStatus = initializeStartupState()
  console.log(`[startup] ${formatStartupStorageSummary(startupStatus.storage)}`)

  console.log('[startup] Step 2: Recover ticket runtime artifacts')
  const recovery = recoverTicketRuntimeArtifacts()
  console.log(`[startup] Recovered ${recovery.recoveredTmpFiles} orphan temp files, repaired ${recovery.repairedExecutionLogs} execution logs, rebuilt ${recovery.rebuiltProjections} state projections`)

  console.log('[startup] Step 3: Start WAL checkpoint timer')
  startWalCheckpoint()

  console.log('[startup] Step 3b: Load user prompt templates')
  try {
    const promptWarnings = initPromptTemplates()
    if (promptWarnings.length === 0) {
      console.log('[startup] Prompt templates loaded')
    } else {
      for (const warning of promptWarnings) {
        console.warn(`[startup] Prompt template "${warning.id}": ${warning.message}`)
      }
    }
  } catch (err) {
    console.warn(`[startup] Prompt template initialization failed, using built-in defaults: ${getErrorMessage(err)}`)
  }

  console.log('[startup] Step 4: OpenCode health check')
  const adapter = getOpenCodeAdapter()
  try {
    const health = await adapter.checkHealth()
    if (health.available) {
      console.log(`[startup] OpenCode is reachable (version: ${health.version ?? 'unknown'})`)
    } else {
      console.warn(`[startup] OpenCode is NOT reachable: ${health.error ?? 'unknown error'}. Start it with \`opencode serve\`.`)
    }
  } catch (err) {
    console.warn(`[startup] OpenCode health check failed: ${getErrorMessage(err)}`)
  }

  console.log('[startup] Step 5: Hydrate XState actors from attached project databases')
  const hydrated = hydrateAllTickets()
  console.log(`[startup] Hydrated ${hydrated} ticket actors`)

  console.log('[startup] Step 6: Reconnecting OpenCode sessions for attached projects')
  const attachedProjects = listProjects()
  if (attachedProjects.length === 0) {
    console.log('[startup] No attached projects to reconnect')
    console.log('[startup] Startup complete')
    return
  }

  try {
    const { reconnected, abandoned, preserved } = await reconcileOpenCodeSessions(adapter, attachedProjects)

    console.log(`[startup] Reconnected ${reconnected} OpenCode sessions, preserved ${preserved} unverified sessions, cleaned up ${abandoned} stale entries`)
  } catch (err) {
    console.warn(`[startup] OpenCode session reconnection failed: ${getErrorMessage(err)}`)
  }

  console.log('[startup] Step 7: Re-arming AI questions left waiting')
  try {
    const { reattached, rejected } = await reconcileOpenCodeQuestions(attachedProjects)
    console.log(`[startup] Re-armed ${reattached} AI questions, refused ${rejected} whose session did not come back`)
  } catch (err) {
    console.warn(`[startup] AI question reconciliation failed: ${getErrorMessage(err)}`)
  }

  console.log('[startup] Startup complete')
}
