import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenCodeAdapter } from '../adapter'
import type {
  HealthStatus,
  Message,
  OpenCodeQuestionAnswer,
  OpenCodeQuestionRequest,
  OpenCodeSessionCreateOptions,
  PromptPart,
  PromptSessionOptions,
  Session,
  StreamEvent,
} from '../types'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { listOpenCodeSessionsForTicket, SessionManager } from '../sessionManager'
import { eq } from 'drizzle-orm'
import { opencodeSessions } from '../../db/schema'
import { getTicketContext } from '../../storage/tickets'
import { attachProject } from '../../storage/projects'
import { createTicket, patchTicket } from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'

class TestOpenCodeAdapter implements OpenCodeAdapter {
  public sessions: Session[] = []
  public createSignals: Array<AbortSignal | undefined> = []
  public listSignals: Array<AbortSignal | undefined> = []
  public getSignals: Array<AbortSignal | undefined> = []
  public createFailures: unknown[] = []
  public healthCalls = 0
  public exactSessionLookup?: (sessionId: string) => Session | null
  private sessionCounter = 0

  async createSession(
    projectPath: string,
    signal?: AbortSignal,
    _options?: OpenCodeSessionCreateOptions,
  ): Promise<Session> {
    this.createSignals.push(signal)
    const failure = this.createFailures.shift()
    if (failure) throw failure instanceof Error ? failure : new Error(String(failure))
    const session: Session = {
      id: `session-${++this.sessionCounter}`,
      projectPath,
      createdAt: new Date().toISOString(),
    }
    this.sessions.push(session)
    return session
  }

  async promptSession(
    _sessionId: string,
    _parts: PromptPart[],
    _signal?: AbortSignal,
    _options?: PromptSessionOptions,
  ): Promise<string> {
    return 'assistant response'
  }

  async listSessions(signal?: AbortSignal): Promise<Session[]> {
    this.listSignals.push(signal)
    return this.sessions
  }

  async getSession(sessionId: string, signal?: AbortSignal): Promise<Session | null> {
    this.getSignals.push(signal)
    if (this.exactSessionLookup) return this.exactSessionLookup(sessionId)
    return this.sessions.find((session) => session.id === sessionId) ?? null
  }

  async getSessionMessages(_sessionId: string): Promise<Message[]> {
    return []
  }

  async listPendingQuestions(): Promise<OpenCodeQuestionRequest[]> {
    return []
  }

  async replyQuestion(_requestId: string, _answers: OpenCodeQuestionAnswer[]): Promise<void> {
    return undefined
  }

  async rejectQuestion(_requestId: string): Promise<void> {
    return undefined
  }

  async *subscribeToEvents(sessionId: string, _signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    yield { type: 'done', sessionId }
  }

  async abortSession(_sessionId: string): Promise<boolean> {
    return true
  }

  async assembleBeadContext(_ticketId: string, _beadId: string): Promise<PromptPart[]> {
    return []
  }

  async assembleCouncilContext(_ticketId: string, _phase: string): Promise<PromptPart[]> {
    return []
  }

  async checkHealth(): Promise<HealthStatus> {
    this.healthCalls += 1
    return { available: true }
  }
}

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-session-manager-',
  files: {
    'README.md': '# Session Manager Test\n',
  },
})

describe('SessionManager', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('requires PRD step ownership to match when reconnecting an active session', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Reconnect PRD sessions by step',
      description: 'Ensure PRD sub-steps do not reuse each other sessions.',
    })
    patchTicket(ticket.id, { status: 'DRAFTING_PRD' })

    const adapter = new TestOpenCodeAdapter()
    const sessionManager = new SessionManager(adapter)
    const created = await sessionManager.createSessionForPhase(
      ticket.id,
      'DRAFTING_PRD',
      1,
      'model-a',
      undefined,
      undefined,
      'full_answers',
      repoDir,
    )

    await expect(sessionManager.validateAndReconnect(ticket.id, 'DRAFTING_PRD', {
      phaseAttempt: 1,
      memberId: 'model-a',
      step: 'full_answers',
    })).resolves.toEqual(created)

    await expect(sessionManager.validateAndReconnect(ticket.id, 'DRAFTING_PRD', {
      phaseAttempt: 1,
      memberId: 'model-a',
      step: 'prd_draft',
    })).resolves.toBeNull()
  })

  it('passes caller signals through create and reconnect operations', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Reconnect cancellation',
      description: 'Ensure SessionManager forwards caller cancellation.',
    })
    patchTicket(ticket.id, { status: 'CODING' })

    const adapter = new TestOpenCodeAdapter()
    const sessionManager = new SessionManager(adapter)
    const controller = new AbortController()

    await sessionManager.createSessionForPhase(
      ticket.id,
      'CODING',
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      repoDir,
      undefined,
      controller.signal,
    )
    await sessionManager.validateAndReconnect(ticket.id, 'CODING', undefined, controller.signal)

    expect(adapter.createSignals).toEqual([controller.signal])
    expect(adapter.getSignals).toEqual([controller.signal])
    expect(adapter.listSignals).toEqual([])
  })

  it('reconnects a non-coding active session by exact id even when session lists omit it', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Reconnect exact session',
      description: 'Ensure list omissions do not lose preserved phase sessions.',
    })
    patchTicket(ticket.id, { status: 'VERIFYING_PRD_COVERAGE' })

    const adapter = new TestOpenCodeAdapter()
    const sessionManager = new SessionManager(adapter)
    const created = await sessionManager.createSessionForPhase(
      ticket.id,
      'VERIFYING_PRD_COVERAGE',
      1,
      'model-a',
      undefined,
      undefined,
      undefined,
      repoDir,
    )
    adapter.sessions = []
    adapter.exactSessionLookup = (sessionId) => sessionId === created.id ? created : null

    await expect(sessionManager.validateAndReconnect(ticket.id, 'VERIFYING_PRD_COVERAGE', {
      phaseAttempt: 1,
      memberId: 'model-a',
    })).resolves.toEqual(created)

    expect(adapter.listSignals).toEqual([])
    expect(listOpenCodeSessionsForTicket(ticket.id, ['active']).map((session) => session.sessionId)).toEqual([created.id])
  })

  it('abandons an active session only when exact lookup confirms it is gone', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Reconnect missing exact session',
      description: 'Ensure missing exact lookup abandons stale active rows.',
    })
    patchTicket(ticket.id, { status: 'VERIFYING_PRD_COVERAGE' })

    const adapter = new TestOpenCodeAdapter()
    const sessionManager = new SessionManager(adapter)
    const created = await sessionManager.createSessionForPhase(
      ticket.id,
      'VERIFYING_PRD_COVERAGE',
      1,
      'model-a',
      undefined,
      undefined,
      undefined,
      repoDir,
    )
    adapter.exactSessionLookup = () => null

    await expect(sessionManager.validateAndReconnect(ticket.id, 'VERIFYING_PRD_COVERAGE', {
      phaseAttempt: 1,
      memberId: 'model-a',
    })).resolves.toBeNull()

    expect(listOpenCodeSessionsForTicket(ticket.id, ['active']).map((session) => session.sessionId)).toEqual([])
    expect(listOpenCodeSessionsForTicket(ticket.id, ['abandoned']).map((session) => session.sessionId)).toEqual([created.id])
    // The state filter moved into the query. An empty list still means "every
    // state", which is what the callers that pass one rely on.
    expect(listOpenCodeSessionsForTicket(ticket.id, []).map((session) => session.sessionId)).toEqual([created.id])
    expect(listOpenCodeSessionsForTicket(ticket.id, ['active', 'abandoned']).map((session) => session.sessionId)).toEqual([created.id])
    expect(listOpenCodeSessionsForTicket(ticket.id, ['nonexistent-state'])).toEqual([])
  })

  it('retries session creation and stores only the successful owned session', async () => {
    vi.useFakeTimers()
    try {
      const repoDir = repoManager.createRepo()
      const project = attachProject({
        folderPath: repoDir,
        name: 'LoopTroop',
        shortname: 'LOOP',
      })
      const ticket = createTicket({
        projectId: project.id,
        title: 'Retry session creation',
        description: 'Ensure failed create attempts do not insert session rows.',
      })
      patchTicket(ticket.id, { status: 'CODING' })

      const adapter = new TestOpenCodeAdapter()
      adapter.createFailures = [
        new Error('OpenCode returned no session payload'),
        new Error('socket hang up'),
      ]
      const sessionManager = new SessionManager(adapter)

      const createPromise = sessionManager.createSessionForPhase(
        ticket.id,
        'CODING',
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        repoDir,
      )

      await vi.runAllTimersAsync()
      const created = await createPromise

      expect(created.id).toBe('session-1')
      expect(adapter.createSignals).toHaveLength(3)
      expect(adapter.healthCalls).toBe(2)
      expect(listOpenCodeSessionsForTicket(ticket.id, ['active']).map((session) => session.sessionId)).toEqual(['session-1'])
    } finally {
      vi.useRealTimers()
    }
  })
  it('reconnects a session row whose stored phase is no longer a declared status', async () => {
    // The phase is a lookup key against a row this process may not have
    // written. Running it through a "narrow it or fall back" helper first
    // rewrites the key, finds nothing, and abandons a session that is alive.
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Reconnect a legacy session phase',
      description: 'A session row written under a status that has since been renamed.',
    })
    patchTicket(ticket.id, { status: 'CODING' })

    const adapter = new TestOpenCodeAdapter()
    const sessionManager = new SessionManager(adapter)
    const created = await sessionManager.createSessionForPhase(
      ticket.id,
      'CODING',
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      repoDir,
    )

    // Rewrite both the row and the ticket to a status this build no longer
    // declares, which is what an upgrade mid-run leaves behind. The session is
    // still live and the two still agree, so the only thing that can lose it is
    // the lookup key being rewritten on the way in.
    const context = getTicketContext(ticket.id)!
    context.projectDb
      .update(opencodeSessions)
      .set({ phase: 'OLD_RENAMED_PHASE' })
      .where(eq(opencodeSessions.sessionId, created.id))
      .run()
    patchTicket(ticket.id, { status: 'OLD_RENAMED_PHASE' })

    adapter.sessions = []
    adapter.exactSessionLookup = (sessionId) => sessionId === created.id ? created : null

    const result = await sessionManager.reconcileActiveSession(ticket.id, 'OLD_RENAMED_PHASE', created.id)

    expect(result.state).toBe('reconnected')
    expect(listOpenCodeSessionsForTicket(ticket.id, ['active']).map((session) => session.sessionId))
      .toEqual([created.id])
  })
})
