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
import { clearProjectDatabaseCache, getExistingProjectDatabase } from '../../db/project'
import {
  abortTicketSessions,
  listOpenCodeSessionsForTicket,
  recoverPendingOpenCodeSessionOwnership,
  SessionManager,
} from '../sessionManager'
import * as opencodeFactory from '../factory'
import { eq } from 'drizzle-orm'
import { opencodeSessions } from '../../db/schema'
import { getTicketContext } from '../../storage/tickets'
import { attachProject } from '../../storage/projects'
import { createTicket, patchTicket } from '../../storage/tickets'
import { readTicketFile, writeTicketFile } from '../../storage/ticketQueries'
import * as ticketQueries from '../../storage/ticketQueries'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import type { WorkflowPhaseId } from '@shared/workflowMeta'

class TestOpenCodeAdapter implements OpenCodeAdapter {
  public sessions: Session[] = []
  public createSignals: Array<AbortSignal | undefined> = []
  public listSignals: Array<AbortSignal | undefined> = []
  public getSignals: Array<AbortSignal | undefined> = []
  public createFailures: unknown[] = []
  public abortResults: boolean[] = []
  public abortCalls: string[] = []
  public forgetCalls: string[] = []
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
    this.abortCalls.push(_sessionId)
    return this.abortResults.shift() ?? true
  }

  forgetSessionDirectory(sessionId: string): void {
    this.forgetCalls.push(sessionId)
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

async function createOwnedSessionFixture(input: {
  phase: WorkflowPhaseId
  memberId?: string
  title: string
  description: string
}) {
  const repoDir = repoManager.createRepo()
  const project = attachProject({
    folderPath: repoDir,
    name: 'LoopTroop',
    shortname: 'LOOP',
  })
  const ticket = createTicket({
    projectId: project.id,
    title: input.title,
    description: input.description,
  })
  patchTicket(ticket.id, { status: input.phase })
  const adapter = new TestOpenCodeAdapter()
  const sessionManager = new SessionManager(adapter)
  const session = await sessionManager.createSessionForPhase(
    ticket.id,
    input.phase,
    1,
    input.memberId,
    undefined,
    undefined,
    undefined,
    repoDir,
  )
  return { repoDir, ticket, adapter, sessionManager, session }
}

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

  it('keeps ownership retryable across a read-only database and restart', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Compensate session ownership failure',
      description: 'A remote session must not survive a failed local insert.',
    })
    patchTicket(ticket.id, { status: 'CODING' })

    const adapter = new TestOpenCodeAdapter()
    adapter.abortResults = [false, false, false, true]
    const sessionManager = new SessionManager(adapter)
    const context = getTicketContext(ticket.id)
    expect(context).toBeDefined()
    const projectDatabase = getExistingProjectDatabase(repoDir)
    expect(projectDatabase).toBeDefined()
    projectDatabase!.sqlite.pragma('query_only = ON')

    await expect(sessionManager.createSessionForPhase(
      ticket.id,
      'CODING',
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      repoDir,
    )).rejects.toThrow()

    expect(adapter.abortCalls).toEqual(['session-1'])
    expect(listOpenCodeSessionsForTicket(ticket.id, ['active'])).toEqual([])
    const pendingOwnership = readTicketFile(ticket.id, 'runtime/opencode-pending-sessions.json')
    expect(JSON.parse(pendingOwnership ?? 'null')).toEqual([expect.objectContaining({ sessionId: 'session-1' })])

    const factorySpy = vi.spyOn(opencodeFactory, 'getOpenCodeAdapter').mockReturnValue(adapter)
    try {
      await expect(abortTicketSessions(ticket.id)).resolves.toBe(false)
      expect(readTicketFile(ticket.id, 'runtime/opencode-pending-sessions.json')).not.toBeNull()

      // Closing the read-only connection is the restart boundary. The next
      // connection is writable, but the marker remains the only ownership source
      // until recovery explicitly replays it into SQLite.
      clearProjectDatabaseCache()
      await expect(abortTicketSessions(ticket.id)).resolves.toBe(false)
      expect(listOpenCodeSessionsForTicket(ticket.id, ['active'])).toEqual([])
      expect(readTicketFile(ticket.id, 'runtime/opencode-pending-sessions.json')).not.toBeNull()

      expect(recoverPendingOpenCodeSessionOwnership(ticket.id)).toBe(true)
      expect(readTicketFile(ticket.id, 'runtime/opencode-pending-sessions.json')).toBeNull()
      expect(listOpenCodeSessionsForTicket(ticket.id, ['active']).map((row) => row.sessionId)).toEqual(['session-1'])

      await expect(abortTicketSessions(ticket.id)).resolves.toBe(true)
      expect(listOpenCodeSessionsForTicket(ticket.id, ['active'])).toEqual([])
      expect(listOpenCodeSessionsForTicket(ticket.id, ['abandoned']).map((row) => row.sessionId)).toEqual(['session-1'])
      expect(adapter.forgetCalls).toContain('session-1')
      expect(adapter.abortCalls).toEqual(['session-1', 'session-1', 'session-1', 'session-1'])
    } finally {
      factorySpy.mockRestore()
    }
  })

  it('does not report all sessions stopped when ownership appears during an abort', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'Late ownership project',
      shortname: 'LATE',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Retain a late session owner',
      description: 'A session created while cleanup is waiting must remain retryable.',
    })
    patchTicket(ticket.id, { status: 'CODING' })

    const adapter = new TestOpenCodeAdapter()
    const sessionManager = new SessionManager(adapter)
    await sessionManager.createSessionForPhase(
      ticket.id,
      'CODING',
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      repoDir,
    )

    let releaseFirstAbort!: () => void
    let signalFirstAbort!: () => void
    const firstAbortStarted = new Promise<void>((resolve) => {
      signalFirstAbort = resolve
    })
    const firstAbortRelease = new Promise<void>((resolve) => {
      releaseFirstAbort = resolve
    })
    let lateAbortCount = 0
    const abortCalls: string[] = []
    const abort = vi.spyOn(adapter, 'abortSession').mockImplementation(async (sessionId) => {
      abortCalls.push(sessionId)
      if (sessionId === 'session-1') {
        signalFirstAbort()
        await firstAbortRelease
        return true
      }
      lateAbortCount += 1
      return lateAbortCount > 1
    })
    const factorySpy = vi.spyOn(opencodeFactory, 'getOpenCodeAdapter').mockReturnValue(adapter)
    const projectDatabase = getExistingProjectDatabase(repoDir)
    expect(projectDatabase).toBeDefined()

    try {
      const sweep = abortTicketSessions(ticket.id)
      await firstAbortStarted

      // Force the late owner through the same failed-INSERT marker fallback
      // while the first remote abort is paused, then restore writes before A
      // reconciles its own row.
      projectDatabase!.sqlite.pragma('query_only = ON')
      const lateCreation = sessionManager.createSessionForPhase(
        ticket.id,
        'CODING',
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        repoDir,
      )
      await expect(lateCreation).rejects.toThrow()
      projectDatabase!.sqlite.pragma('query_only = OFF')
      releaseFirstAbort()

      await expect(sweep).resolves.toBe(false)
      expect(JSON.parse(readTicketFile(ticket.id, 'runtime/opencode-pending-sessions.json') ?? 'null'))
        .toEqual([expect.objectContaining({ sessionId: 'session-2' })])

      await expect(abortTicketSessions(ticket.id)).resolves.toBe(true)
      expect(readTicketFile(ticket.id, 'runtime/opencode-pending-sessions.json')).toBeNull()
      expect(listOpenCodeSessionsForTicket(ticket.id, ['active'])).toEqual([])
      expect(listOpenCodeSessionsForTicket(ticket.id, ['abandoned']).map((row) => row.sessionId))
        .toEqual(['session-1'])
      expect(abortCalls).toEqual(['session-1', 'session-2', 'session-2'])
    } finally {
      projectDatabase!.sqlite.pragma('query_only = OFF')
      releaseFirstAbort()
      abort.mockRestore()
      factorySpy.mockRestore()
    }
  })

  it('does not report an empty ticket stopped while a managed session create is in flight', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'Pending create project',
      shortname: 'PENDING',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Wait for pending session create',
      description: 'Cleanup must account for a remote create before its id exists.',
    })
    const aliasTicketId = `0${project.id}:${ticket.externalId}`
    patchTicket(ticket.id, { status: 'CODING' })

    const adapter = new TestOpenCodeAdapter()
    const sessionManager = new SessionManager(adapter)
    let releaseCreate!: () => void
    let signalCreateStarted!: () => void
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve
    })
    const createRelease = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    const create = vi.spyOn(adapter, 'createSession').mockImplementation(async (projectPath) => {
      signalCreateStarted()
      await createRelease
      return {
        id: 'session-pending-create',
        projectPath,
        createdAt: new Date().toISOString(),
      }
    })
    const factorySpy = vi.spyOn(opencodeFactory, 'getOpenCodeAdapter').mockReturnValue(adapter)

    try {
      const creation = sessionManager.createSessionForPhase(
        ticket.id,
        'CODING',
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        repoDir,
      )
      await createStarted

      await expect(abortTicketSessions(aliasTicketId)).resolves.toBe(false)
      expect(adapter.abortCalls).toEqual([])

      releaseCreate()
      await expect(creation).resolves.toMatchObject({ id: 'session-pending-create' })
      await expect(abortTicketSessions(aliasTicketId)).resolves.toBe(true)
      expect(listOpenCodeSessionsForTicket(ticket.id, ['active'])).toEqual([])
    } finally {
      releaseCreate()
      create.mockRestore()
      factorySpy.mockRestore()
    }
  })

  it('canonicalizes process-only ownership when an alias requests cleanup', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'Process-only ownership project',
      shortname: 'PROCESS',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Retain process-only ownership',
      description: 'An alias must still find a non-durable owner in this process.',
    })
    const aliasTicketId = `0${project.id}:${ticket.externalId}`
    patchTicket(ticket.id, { status: 'CODING' })

    const adapter = new TestOpenCodeAdapter()
    adapter.abortResults = [false, false, true]
    const sessionManager = new SessionManager(adapter)
    const context = getTicketContext(ticket.id)!
    const projectDatabase = getExistingProjectDatabase(repoDir)
    expect(projectDatabase).toBeDefined()
    const insert = vi.spyOn(context.projectDb, 'insert').mockImplementation(() => {
      throw new Error('drizzle insert unavailable')
    })
    const markerWrite = vi.spyOn(ticketQueries, 'writeTicketFile').mockImplementation(() => {
      throw new Error('pending marker unavailable')
    })
    const factorySpy = vi.spyOn(opencodeFactory, 'getOpenCodeAdapter').mockReturnValue(adapter)

    try {
      projectDatabase!.sqlite.pragma('query_only = ON')
      await expect(sessionManager.createSessionForPhase(
        ticket.id,
        'CODING',
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        repoDir,
      )).rejects.toThrow('drizzle insert unavailable')
      projectDatabase!.sqlite.pragma('query_only = OFF')

      expect(markerWrite).toHaveBeenCalled()
      expect(readTicketFile(ticket.id, 'runtime/opencode-pending-sessions.json')).toBeNull()
      await expect(abortTicketSessions(aliasTicketId)).resolves.toBe(false)
      await expect(abortTicketSessions(aliasTicketId)).resolves.toBe(true)
      expect(adapter.abortCalls).toEqual(['session-1', 'session-1', 'session-1'])
      expect(adapter.forgetCalls).toContain('session-1')
    } finally {
      projectDatabase!.sqlite.pragma('query_only = OFF')
      markerWrite.mockRestore()
      insert.mockRestore()
      factorySpy.mockRestore()
    }
  })

  it('forgets directory state when a session reaches a terminal state', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Retain uncertain session',
      description: 'An uncertain remote stop remains retryable.',
    })
    patchTicket(ticket.id, { status: 'CODING' })

    const adapter = new TestOpenCodeAdapter()
    const sessionManager = new SessionManager(adapter)
    const session = await sessionManager.createSessionForPhase(
      ticket.id,
      'CODING',
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      repoDir,
    )
    writeTicketFile(ticket.id, 'runtime/opencode-pending-sessions.json', JSON.stringify([{
      sessionId: session.id,
      phase: 'CODING',
      phaseAttempt: 1,
      memberId: null,
      beadId: null,
      iteration: null,
      step: null,
    }]))

    await sessionManager.completeSession(session.id)
    const row = getTicketContext(ticket.id)?.projectDb.select().from(opencodeSessions)
      .where(eq(opencodeSessions.sessionId, session.id))
      .get()
    expect(row?.state).toBe('completed')
    expect(readTicketFile(ticket.id, 'runtime/opencode-pending-sessions.json')).toBeNull()
    expect(adapter.forgetCalls).toContain(session.id)
  })

  it('abandons fallback ownership when compensation confirms the remote stop', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Reconcile fallback ownership',
      description: 'A confirmed compensation must not leave an active local row.',
    })
    patchTicket(ticket.id, { status: 'CODING' })

    const adapter = new TestOpenCodeAdapter()
    adapter.abortResults = [true]
    const sessionManager = new SessionManager(adapter)
    const context = getTicketContext(ticket.id)!
    const insert = vi.spyOn(context.projectDb, 'insert').mockImplementation(() => {
      throw new Error('drizzle insert unavailable')
    })

    try {
      await expect(sessionManager.createSessionForPhase(
        ticket.id,
        'CODING',
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        repoDir,
      )).rejects.toThrow('drizzle insert unavailable')
    } finally {
      insert.mockRestore()
    }

    expect(listOpenCodeSessionsForTicket(ticket.id, ['active'])).toEqual([])
    expect(listOpenCodeSessionsForTicket(ticket.id, ['abandoned']).map((row) => row.sessionId))
      .toEqual(['session-1'])
    expect(adapter.forgetCalls).toContain('session-1')
  })

  it('keeps an ownership row active until a remote abort is confirmed', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Keep uncertain ownership',
      description: 'A failed stop must remain retryable.',
    })
    patchTicket(ticket.id, { status: 'CODING' })

    const adapter = new TestOpenCodeAdapter()
    const sessionManager = new SessionManager(adapter)
    const session = await sessionManager.createSessionForPhase(
      ticket.id,
      'CODING',
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      repoDir,
    )
    adapter.abortResults = [false, true]

    await expect(sessionManager.abortAndAbandonSession(session.id)).resolves.toBe(false)
    expect(listOpenCodeSessionsForTicket(ticket.id, ['active']).map((row) => row.sessionId)).toEqual([session.id])

    await expect(sessionManager.abortAndAbandonSession(session.id)).resolves.toBe(true)
    expect(listOpenCodeSessionsForTicket(ticket.id, ['active'])).toEqual([])
    expect(listOpenCodeSessionsForTicket(ticket.id, ['abandoned']).map((row) => row.sessionId)).toEqual([session.id])
  })

  it('reconnects a non-coding active session by exact id even when session lists omit it', async () => {
    const { ticket, adapter, sessionManager, session: created } = await createOwnedSessionFixture({
      phase: 'VERIFYING_PRD_COVERAGE',
      memberId: 'model-a',
      title: 'Reconnect exact session',
      description: 'Ensure list omissions do not lose preserved phase sessions.',
    })
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
    const { ticket, adapter, sessionManager, session: created } = await createOwnedSessionFixture({
      phase: 'VERIFYING_PRD_COVERAGE',
      memberId: 'model-a',
      title: 'Reconnect missing exact session',
      description: 'Ensure missing exact lookup abandons stale active rows.',
    })
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

  it('does not replace a stale session until its remote stop is confirmed', async () => {
    const { ticket, adapter, sessionManager, session: created } = await createOwnedSessionFixture({
      phase: 'CODING',
      title: 'Stop stale session before replacement',
      description: 'A status change must not let a stale session race a new one.',
    })
    patchTicket(ticket.id, { status: 'WAITING_INTERVIEW_APPROVAL' })
    adapter.abortResults = [false, true]

    await expect(sessionManager.validateAndReconnect(ticket.id, 'CODING')).rejects
      .toThrow(`Could not confirm abort of stale OpenCode session ${created.id}`)
    expect(listOpenCodeSessionsForTicket(ticket.id, ['active']).map((row) => row.sessionId))
      .toEqual([created.id])

    await expect(sessionManager.validateAndReconnect(ticket.id, 'CODING')).resolves.toBeNull()
    expect(listOpenCodeSessionsForTicket(ticket.id, ['active'])).toEqual([])
    expect(listOpenCodeSessionsForTicket(ticket.id, ['abandoned']).map((row) => row.sessionId))
      .toEqual([created.id])
    expect(adapter.abortCalls).toEqual([created.id, created.id])
  })

  it('refuses a replacement when the active session cannot be verified', async () => {
    const { ticket, adapter, sessionManager, session: created } = await createOwnedSessionFixture({
      phase: 'CODING',
      title: 'Preserve unverified session',
      description: 'A lookup failure must not start replacement work.',
    })
    adapter.exactSessionLookup = () => {
      throw new Error('ECONNREFUSED')
    }

    await expect(sessionManager.validateAndReconnect(ticket.id, 'CODING')).rejects
      .toThrow(`Could not verify whether OpenCode session ${created.id} is still active`)
    expect(listOpenCodeSessionsForTicket(ticket.id, ['active']).map((row) => row.sessionId))
      .toEqual([created.id])
    expect(adapter.abortCalls).toEqual([])
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
    const { ticket, adapter, sessionManager, session: created } = await createOwnedSessionFixture({
      phase: 'CODING',
      title: 'Reconnect a legacy session phase',
      description: 'A session row written under a status that has since been renamed.',
    })

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
