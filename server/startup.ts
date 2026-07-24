import { eq } from 'drizzle-orm'
import { initializeDatabase } from './db/init'
import { startWalCheckpoint } from './db/index'
import { createIndexes } from './db/indexes'
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

  console.log('[startup] Startup complete')
}
