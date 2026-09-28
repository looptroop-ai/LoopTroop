import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { opencodeSessions } from '../../db/schema'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attachProject } from '../../storage/projects'
import { createTicket, getTicketContext, getTicketByRef, ensureActivePhaseAttempt, patchTicket } from '../../storage/tickets'
import { readTicketMeta } from '../../ticket/metadata'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { makeTempDir, removeTempDir } from '../../test/tempDir'
import { TEST } from '../../test/factories'
import { clearAllPendingSessionContinuationsForTests, getPendingSessionContinuationForTicketPhase } from '../../opencode/sessionContinuation'
import { clearTicketWindows } from '../../workflow/questionWindows'
import { schedulePendingCancellationCleanupRetry } from '../../workflow/runner'
import { LOOPTROOP_OPENCODE_ROUTING_CONFIG } from '../../../shared/openRouterRouting'

const {
  abortTicketSessionsMock,
  clearTicketWindowsMock,
  getOpenCodeConnectionMock,
  getTicketStateMock,
  getSessionMock,
  initializeTicketMock,
  scheduleCancellationRetryMock,
  sendTicketEventMock,
  stopActorMock,
  validateModelSelectionMock,
  withProviderCatalogReloadMock,
} = vi.hoisted(() => ({
  abortTicketSessionsMock: vi.fn(),
  clearTicketWindowsMock: vi.fn(),
  getOpenCodeConnectionMock: vi.fn(),
  getTicketStateMock: vi.fn(),
  getSessionMock: vi.fn(),
  initializeTicketMock: vi.fn(),
  scheduleCancellationRetryMock: vi.fn(),
  sendTicketEventMock: vi.fn(),
  stopActorMock: vi.fn(),
  validateModelSelectionMock: vi.fn(),
  withProviderCatalogReloadMock: vi.fn(),
}))

vi.mock('../../opencode/sessionManager', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../opencode/sessionManager')>(),
  abortTicketSessions: abortTicketSessionsMock,
}))

vi.mock('../../opencode/factory', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../opencode/factory')>(),
  getOpenCodeAdapter: vi.fn(() => ({ getSession: getSessionMock })),
}))

vi.mock('../../opencode/connection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../opencode/connection')>(),
  getOpenCodeConnection: getOpenCodeConnectionMock,
}))

vi.mock('../../opencode/modelValidation', () => ({ validateModelSelection: validateModelSelectionMock }))

vi.mock('../../opencode/providerCatalog', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../opencode/providerCatalog')>(),
  withProviderCatalogReload: withProviderCatalogReloadMock,
}))

vi.mock('../../ticket/initialize', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../ticket/initialize')>(),
  initializeTicket: initializeTicketMock,
}))

vi.mock('../../machines/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../machines/persistence')>(),
  ensureActorForTicket: vi.fn(() => ({ id: 'mock-actor' })),
  getTicketState: getTicketStateMock,
  sendTicketEvent: sendTicketEventMock,
  stopActor: stopActorMock,
}))

vi.mock('../../workflow/questionWindows', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../workflow/questionWindows')>(),
  clearTicketWindows: clearTicketWindowsMock,
}))

vi.mock('../../workflow/runner', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../workflow/runner')>(),
  schedulePendingCancellationCleanupRetry: scheduleCancellationRetryMock,
}))

import { abortTicketSessions } from '../../opencode/sessionManager'
import { getOpenCodeConnection } from '../../opencode/connection'
import { initializeTicket } from '../../ticket/initialize'
import { sendTicketEvent, stopActor } from '../../machines/persistence'
import { ticketRouter } from '../tickets'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-lifecycle-retry-coverage-',
  files: { 'README.md': '# Retry route coverage\n' },
})
const tempDirs: string[] = []

function setupRetryApp() {
  const repoDir = repoManager.createRepo()
  const project = attachProject({
    folderPath: repoDir,
    name: TEST.projectName,
    shortname: TEST.shortname,
  })
  const ticket = createTicket({
    projectId: project.id,
    title: 'Retry lifecycle coverage',
    description: 'Exercise a retry recovery boundary.',
  })
  const app = new Hono()
  app.route('/api', ticketRouter)
  return { app, project, ticket }
}

function blockTicket(ticketId: string, previousStatus: string) {
  patchTicket(ticketId, {
    status: 'BLOCKED_ERROR',
    xstateSnapshot: JSON.stringify({ context: { previousStatus } }),
    errorMessage: `${previousStatus} failed`,
  })
}

function insertSetupSession(ticketId: string) {
  const context = getTicketContext(ticketId)
  if (!context) throw new Error(`Missing ticket context for ${ticketId}`)
  context.projectDb.insert(opencodeSessions).values({
    sessionId: 'session-setup',
    ticketId: context.localTicketId,
    phase: 'PREPARING_EXECUTION_ENV',
    phaseAttempt: 1,
    state: 'abandoned',
  }).run()
}

describe('ticket lifecycle recovery guards', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
    clearAllPendingSessionContinuationsForTests()
    abortTicketSessionsMock.mockReset().mockResolvedValue(true)
    getSessionMock.mockReset().mockResolvedValue({ id: 'session-setup', projectPath: '/workspace' })
    getOpenCodeConnectionMock.mockReset().mockResolvedValue({ protocol: 'v1', version: '1.0.0', headers: {} })
    getTicketStateMock.mockReset().mockReturnValue(null)
    validateModelSelectionMock.mockReset().mockResolvedValue({
      mainImplementer: 'openrouter/deepseek/deepseek-v4-flash:floor',
      councilMembers: ['openrouter/deepseek/deepseek-v4-flash:floor'],
    })
    initializeTicketMock.mockReset().mockResolvedValue({
      worktreePath: '/workspace',
      ticketDir: '/workspace/.looptroop',
      branchName: 'test-branch',
      baseBranch: 'main',
      reused: false,
    })
    clearTicketWindowsMock.mockReset().mockResolvedValue(true)
    scheduleCancellationRetryMock.mockReset()
    sendTicketEventMock.mockReset()
    stopActorMock.mockReset()
    withProviderCatalogReloadMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  afterAll(() => {
    clearAllPendingSessionContinuationsForTests()
    for (const dir of tempDirs.splice(0)) removeTempDir(dir)
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('refuses a CODING retry until the previous OpenCode session stop is confirmed', async () => {
    const { app, ticket } = setupRetryApp()
    blockTicket(ticket.id, 'CODING')
    vi.mocked(abortTicketSessions).mockResolvedValueOnce(false)

    const response = await app.request(`/api/tickets/${ticket.id}/retry`, { method: 'POST' })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: 'Retry is not available until the previous OpenCode session stop is confirmed',
    })
    expect(sendTicketEvent).not.toHaveBeenCalled()
    expect(getTicketByRef(ticket.id)?.status).toBe('BLOCKED_ERROR')
  })

  it('refuses a start request once the ticket has left DRAFT', async () => {
    const { app, ticket } = setupRetryApp()
    patchTicket(ticket.id, { status: 'DRAFTING_PRD' })

    const response = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Ticket can only be started from DRAFT status' })
    expect(getTicketByRef(ticket.id)?.status).toBe('DRAFTING_PRD')
  })

  it('registers a newly selected OpenRouter model and reloads its catalog before starting', async () => {
    const configDir = makeTempDir('ticket-lifecycle-routing-config-')
    tempDirs.push(configDir)
    const configPath = join(configDir, 'opencode.json')
    writeFileSync(configPath, '{}\n')
    vi.stubEnv(LOOPTROOP_OPENCODE_ROUTING_CONFIG, configPath)
    const { app, ticket } = setupRetryApp()
    const refreshCatalog = vi.fn().mockResolvedValue({})
    withProviderCatalogReloadMock.mockImplementationOnce(async (operation) =>
      operation({ protocol: 'v1', version: '1.0.0', headers: {} }, refreshCatalog))

    const response = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

    expect(response.status).toBe(200)
    expect(getOpenCodeConnection).toHaveBeenCalledOnce()
    expect(withProviderCatalogReloadMock).toHaveBeenCalledOnce()
    expect(refreshCatalog).toHaveBeenCalledOnce()
    expect(initializeTicket).toHaveBeenCalledOnce()
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      provider: {
        openrouter: {
          models: { 'deepseek/deepseek-v4-flash:floor': {} },
        },
      },
    })
  })

  it('clears provisional model locks when START dispatch fails so a draft can be retried', async () => {
    const { app, project, ticket } = setupRetryApp()
    validateModelSelectionMock.mockResolvedValueOnce({
      mainImplementer: TEST.implementer,
      councilMembers: [...TEST.councilMembers],
    })
    const dispatchError = new Error('actor stopped before start')
    sendTicketEventMock.mockImplementationOnce(() => { throw dispatchError })

    const failedStart = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

    expect(failedStart.status).toBe(500)
    expect(await failedStart.json()).toEqual({
      error: 'Failed to start ticket',
      details: dispatchError.message,
    })
    expect(getTicketByRef(ticket.id)).toMatchObject({
      status: 'DRAFT',
      startedAt: null,
      lockedMainImplementer: null,
      lockedCouncilMembers: [],
    })
    expect(stopActor).toHaveBeenCalledOnce()
    const ticketMeta = readTicketMeta(project.folderPath, ticket.externalId)
    expect(ticketMeta).not.toHaveProperty('startedAt')
    expect(ticketMeta).not.toHaveProperty('lockedMainImplementer')
    expect(ticketMeta).not.toHaveProperty('lockedCouncilMembers')

    validateModelSelectionMock.mockResolvedValueOnce({
      mainImplementer: TEST.model,
      councilMembers: [TEST.model],
    })
    const retriedStart = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

    expect(retriedStart.status).toBe(200)
    expect(getTicketByRef(ticket.id)).toMatchObject({
      status: 'DRAFT',
      lockedMainImplementer: TEST.model,
      lockedCouncilMembers: [TEST.model],
    })
    expect(readTicketMeta(project.folderPath, ticket.externalId)).toMatchObject({
      lockedMainImplementer: TEST.model,
      lockedCouncilMembers: [TEST.model],
    })
  })

  it('does not roll back start settings after START has been persisted', async () => {
    const { app, project, ticket } = setupRetryApp()
    validateModelSelectionMock.mockResolvedValueOnce({
      mainImplementer: TEST.implementer,
      councilMembers: [...TEST.councilMembers],
    })
    const dispatchError = new Error('persistence failed after START transition')
    sendTicketEventMock.mockImplementationOnce(() => {
      getTicketStateMock.mockReturnValueOnce({ state: 'SCANNING_RELEVANT_FILES' })
      patchTicket(ticket.id, { status: 'SCANNING_RELEVANT_FILES' })
      throw dispatchError
    })

    const response = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: 'Failed to start ticket',
      details: dispatchError.message,
    })
    expect(getTicketByRef(ticket.id)).toMatchObject({
      status: 'SCANNING_RELEVANT_FILES',
      lockedMainImplementer: TEST.implementer,
      lockedCouncilMembers: [...TEST.councilMembers],
    })
    expect(readTicketMeta(project.folderPath, ticket.externalId)).toMatchObject({
      lockedMainImplementer: TEST.implementer,
      lockedCouncilMembers: [...TEST.councilMembers],
    })
    expect(stopActor).not.toHaveBeenCalled()
  })

  it('keeps cancellation pending until an open question window can be cleared', async () => {
    const { app, ticket } = setupRetryApp()
    patchTicket(ticket.id, { status: 'DRAFTING_PRD' })
    clearTicketWindowsMock.mockResolvedValue(false)

    const response = await app.request(`/api/tickets/${ticket.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: 'Cancellation could not be confirmed while OpenCode work is still active',
    })
    expect(clearTicketWindows).toHaveBeenCalledTimes(2)
    expect(abortTicketSessions).toHaveBeenCalledTimes(1)
    expect(schedulePendingCancellationCleanupRetry).toHaveBeenCalledWith(ticket.id, expect.anything(), expect.any(Function))
    expect(sendTicketEvent).not.toHaveBeenCalled()
    expect(getTicketByRef(ticket.id)?.status).toBe('DRAFTING_PRD')
  })

  it('refuses a CODING retry while another ticket occupies the project execution band', async () => {
    const { app, project, ticket } = setupRetryApp()
    const runningTicket = createTicket({
      projectId: project.id,
      title: 'Another test ticket',
      description: 'Occupy the execution band.',
    })
    patchTicket(runningTicket.id, { status: 'CODING' })
    blockTicket(ticket.id, 'CODING')

    const response = await app.request(`/api/tickets/${ticket.id}/retry`, { method: 'POST' })
    const body = await response.json() as { error?: string }

    expect(response.status).toBe(409)
    expect(body.error).toContain(runningTicket.externalId)
    expect(abortTicketSessions).not.toHaveBeenCalled()
  })

  it('reports when a workspace retry session cannot be verified before queuing its note', async () => {
    const { app, ticket } = setupRetryApp()
    ensureActivePhaseAttempt(ticket.id, 'PREPARING_EXECUTION_ENV')
    insertSetupSession(ticket.id)
    blockTicket(ticket.id, 'PREPARING_EXECUTION_ENV')
    getSessionMock.mockRejectedValueOnce(new Error('OpenCode unavailable'))

    const response = await app.request(`/api/tickets/${ticket.id}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Inspect the retained workspace.' }),
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: 'Retry with extra note is not available because the workspace setup session could not be verified',
      details: 'OpenCode unavailable',
    })
    expect(getPendingSessionContinuationForTicketPhase(ticket.id, 'PREPARING_EXECUTION_ENV')).toBeNull()
    expect(sendTicketEvent).not.toHaveBeenCalled()
  })

  it('refuses a workspace setup retry note when no saved setup session can be recovered', async () => {
    const { app, ticket } = setupRetryApp()
    ensureActivePhaseAttempt(ticket.id, 'PREPARING_EXECUTION_ENV')
    blockTicket(ticket.id, 'PREPARING_EXECUTION_ENV')

    const response = await app.request(`/api/tickets/${ticket.id}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Inspect the saved workspace first.' }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: 'Retry with extra note is not available because the workspace setup session could not be recovered',
    })
    expect(sendTicketEvent).not.toHaveBeenCalled()
    expect(getPendingSessionContinuationForTicketPhase(ticket.id, 'PREPARING_EXECUTION_ENV')).toBeNull()
  })

  it('keeps workspace setup retry blocked until the previous session stop is confirmed', async () => {
    const { app, ticket } = setupRetryApp()
    blockTicket(ticket.id, 'PREPARING_EXECUTION_ENV')
    abortTicketSessionsMock.mockResolvedValueOnce(false)

    const response = await app.request(`/api/tickets/${ticket.id}/retry`, { method: 'POST' })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: 'Retry is not available until the previous OpenCode session stop is confirmed',
    })
    expect(sendTicketEvent).not.toHaveBeenCalled()
    expect(getTicketByRef(ticket.id)?.status).toBe('BLOCKED_ERROR')
  })

  it('clears the queued workspace retry note if RETRY dispatch fails', async () => {
    const { app, ticket } = setupRetryApp()
    ensureActivePhaseAttempt(ticket.id, 'PREPARING_EXECUTION_ENV')
    insertSetupSession(ticket.id)
    blockTicket(ticket.id, 'PREPARING_EXECUTION_ENV')
    const dispatchError = new Error('actor stopped before retry')
    vi.mocked(sendTicketEvent).mockImplementationOnce(() => { throw dispatchError })

    const response = await app.request(`/api/tickets/${ticket.id}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Inspect the retained workspace.' }),
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: 'Failed to retry workspace setup with the extra note',
      details: dispatchError.message,
    })
    expect(getPendingSessionContinuationForTicketPhase(ticket.id, 'PREPARING_EXECUTION_ENV')).toBeNull()
    expect(getTicketByRef(ticket.id)?.status).toBe('BLOCKED_ERROR')
  })

  it('keeps the ticket blocked when the RETRY event cannot be dispatched', async () => {
    const { app, ticket } = setupRetryApp()
    ensureActivePhaseAttempt(ticket.id, 'REFINING_PRD')
    blockTicket(ticket.id, 'REFINING_PRD')
    const dispatchError = new Error('actor stopped before retry')
    vi.mocked(sendTicketEvent).mockImplementationOnce(() => { throw dispatchError })

    const response = await app.request(`/api/tickets/${ticket.id}/retry`, { method: 'POST' })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: 'Failed to retry ticket',
      details: dispatchError.message,
    })
    expect(getTicketByRef(ticket.id)?.status).toBe('BLOCKED_ERROR')
  })
})
