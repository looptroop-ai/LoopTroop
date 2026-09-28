import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { broadcaster } from '../../sse/broadcaster'
import { attachProject, updateProject } from '../../storage/projects'
import { createTicket, DISPLAY_ONLY_MOCK_BRANCH_NAME, getTicketByRef, getTicketPaths, patchTicket, updateTicket } from '../../storage/tickets'
import { getTicketState, sendTicketEvent, stopActor } from '../../machines/persistence'
import * as ticketStorage from '../../storage/tickets'
import * as ticketFileStorage from '../../ticket/containedPath'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { makeTempDir, removeTempDir } from '../../test/tempDir'
import { LOOPTROOP_OPENCODE_ROUTING_CONFIG } from '../../../shared/openRouterRouting'
const { mockGetOpenCodeConnection } = vi.hoisted(() => ({ mockGetOpenCodeConnection: vi.fn() }))
vi.mock('../../opencode/connection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../opencode/connection')>(),
  getOpenCodeConnection: mockGetOpenCodeConnection,
}))
import { beginOpenCodePromptActivity } from '../../opencode/providerCatalogReload'
import * as workflowRunner from '../../workflow/runner'

vi.mock('../../machines/persistence', async () => {
  const storage = await import('../../storage/tickets')

  return {
    createTicketActor: vi.fn(),
    ensureActorForTicket: vi.fn(() => ({ id: 'mock-actor' })),
    sendTicketEvent: vi.fn((ticketRef: string | number, event: { type: string; message?: string | null }) => {
      const resolvedTicketRef = String(ticketRef)
      if (event.type === 'START') {
        storage.patchTicket(resolvedTicketRef, { status: 'SCANNING_RELEVANT_FILES' })
      }
      if (event.type === 'INIT_FAILED') {
        storage.patchTicket(resolvedTicketRef, {
          status: 'BLOCKED_ERROR',
          errorMessage: event.message ?? null,
        })
      }
      return { value: event.type }
    }),
    getTicketState: vi.fn((ticketRef: string | number) => {
      const ticket = storage.getTicketByRef(String(ticketRef))
      if (!ticket) return null
      return {
        state: ticket.status,
        context: {},
        status: 'active',
      }
    }),
    stopActor: vi.fn(() => true),
  }
})

vi.mock('../../opencode/modelValidation', () => ({
  validateModelSelection: vi.fn(),
}))

vi.mock('../../ticket/initialize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ticket/initialize')>()
  return {
    ...actual,
    initializeTicket: vi.fn(actual.initializeTicket),
  }
})

import { validateModelSelection } from '../../opencode/modelValidation'
import { TicketInitializationError, initializeTicket } from '../../ticket/initialize'
import { TicketMetadataFormatError } from '../../ticket/metadata'
import { ticketRouter } from '../tickets'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-ticket-route-start-',
  files: {
    'README.md': '# LoopTroop Ticket Route Start Test\n',
  },
})

interface PersistedLogEvent {
  phase?: string
  type?: string
  message?: string
  content?: string
}

function setupStartTicketApp() {
  const repoDir = repoManager.createRepo()
  const project = attachProject({
    folderPath: repoDir,
    name: 'LoopTroop',
    shortname: 'LOOP',
  })
  const ticket = createTicket({
    projectId: project.id,
    title: 'Start route',
    description: 'Verify start logging.',
  })

  const app = new Hono()
  app.route('/api', ticketRouter)

  return { app, project, ticket }
}

function readPersistedLogEvents(ticketId: string): PersistedLogEvent[] {
  const paths = getTicketPaths(ticketId)
  if (!paths || !existsSync(paths.executionLogPath)) return []

  const raw = readFileSync(paths.executionLogPath, 'utf-8').trim()
  if (!raw) return []

  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as PersistedLogEvent)
}

function getDraftLogMessages(ticketId: string): string[] {
  return readPersistedLogEvents(ticketId)
    .filter((entry) => entry.phase === 'DRAFT')
    .map((entry) => String(entry.message ?? entry.content ?? ''))
    .filter((msg) => !msg.startsWith('$ ') && !msg.startsWith('[CMD]'))
}

describe('ticketRouter POST /tickets/:id/start', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    mockGetOpenCodeConnection.mockReset()

    vi.mocked(validateModelSelection).mockResolvedValue({
      mainImplementer: 'openai/codex-mini-latest',
      councilMembers: [
        'openai/codex-mini-latest',
        'openai/gpt-5.3-codex',
        'anthropic/claude-sonnet-4',
      ],
    })
    vi.mocked(initializeTicket).mockClear()
    vi.mocked(sendTicketEvent).mockClear()
    vi.mocked(stopActor).mockClear()
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('persists and emits ordered DRAFT logs before the ticket leaves backlog', async () => {
    const { app, ticket } = setupStartTicketApp()
    const broadcastSpy = vi.spyOn(broadcaster, 'broadcast')

    const response = await app.request(`/api/tickets/${ticket.id}/start`, {
      method: 'POST',
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { status?: string; message?: string }
    expect(payload).toMatchObject({
      status: 'SCANNING_RELEVANT_FILES',
      message: 'Start action accepted',
    })
    expect(getTicketByRef(ticket.id)?.status).toBe('SCANNING_RELEVANT_FILES')
    expect(getTicketByRef(ticket.id)?.lockedStructuredRetryCount).toBe(1)

    expect(getDraftLogMessages(ticket.id)).toEqual([
      'Start requested.',
      'Validating model availability.',
      '✓ Model Availability: Main implementer openai/codex-mini-latest; council size 3.',
      'Initializing workspace and ticket directories.',
      `✓ Workspace Init: Ready on branch ${ticket.externalId} (new worktree and ticket directories created).`,
      'Locking start configuration.',
      '✓ Start Config: Configuration locked.',
      '✓ Workflow Dispatch: Start dispatched.',
    ])

    const emittedDraftLogs = broadcastSpy.mock.calls
      .filter(([, event, data]) => event === 'log' && data.phase === 'DRAFT')
      .map(([, , data]) => String(data.content ?? ''))
      .filter((msg: string) => !msg.startsWith('$ ') && !msg.startsWith('[CMD]'))

    expect(emittedDraftLogs).toEqual([
      'Start requested.',
      'Validating model availability.',
      '✓ Model Availability: Main implementer openai/codex-mini-latest; council size 3.',
      'Initializing workspace and ticket directories.',
      `✓ Workspace Init: Ready on branch ${ticket.externalId} (new worktree and ticket directories created).`,
      'Locking start configuration.',
      '✓ Start Config: Configuration locked.',
      '✓ Workflow Dispatch: Start dispatched.',
    ])

    broadcaster.clearTicket(ticket.id)
  })

  it('rejects malformed ticket metadata before initializing the workspace', async () => {
    const { app, ticket } = setupStartTicketApp()
    const metadataPath = join(getTicketPaths(ticket.id)!.ticketDir, 'meta', 'ticket.meta.json')
    writeFileSync(metadataPath, '{bad')

    const response = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'Ticket metadata must contain a JSON object before the ticket can start.',
    })
    expect(initializeTicket).not.toHaveBeenCalled()
    expect(getTicketByRef(ticket.id)).toMatchObject({ status: 'DRAFT' })
    expect(readFileSync(metadataPath, 'utf8')).toBe('{bad')
    broadcaster.clearTicket(ticket.id)
  })

  it('keeps a ticket in DRAFT if metadata becomes malformed during initialization', async () => {
    const { app, ticket } = setupStartTicketApp()
    const metadataPath = join(getTicketPaths(ticket.id)!.ticketDir, 'meta', 'ticket.meta.json')
    vi.mocked(initializeTicket).mockImplementationOnce(async () => {
      writeFileSync(metadataPath, '{bad')
      throw new TicketMetadataFormatError()
    })

    const response = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'Ticket metadata must contain a JSON object before the ticket can start.',
    })
    expect(sendTicketEvent).not.toHaveBeenCalled()
    expect(getTicketByRef(ticket.id)).toMatchObject({ status: 'DRAFT' })
    expect(readFileSync(metadataPath, 'utf8')).toBe('{bad')
    broadcaster.clearTicket(ticket.id)
  })

  it('keeps a ticket in DRAFT if metadata becomes malformed after workspace initialization', async () => {
    const { app, ticket } = setupStartTicketApp()
    const paths = getTicketPaths(ticket.id)!
    const metadataPath = join(paths.ticketDir, 'meta', 'ticket.meta.json')
    vi.mocked(initializeTicket).mockImplementationOnce(async () => {
      writeFileSync(metadataPath, '{bad')
      return {
        worktreePath: paths.worktreePath,
        ticketDir: paths.ticketDir,
        branchName: ticket.externalId,
        baseBranch: 'main',
        reused: false,
      }
    })

    const response = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'Ticket metadata must contain a JSON object before the ticket can start.',
    })
    expect(sendTicketEvent).not.toHaveBeenCalled()
    expect(getTicketByRef(ticket.id)).toMatchObject({ status: 'DRAFT' })
    expect(readFileSync(metadataPath, 'utf8')).toBe('{bad')
    broadcaster.clearTicket(ticket.id)
  })

  it('rejects display-only mock tickets before workspace initialization', async () => {
    const { app, ticket } = setupStartTicketApp()
    patchTicket(ticket.id, {
      branchName: DISPLAY_ONLY_MOCK_BRANCH_NAME,
    })

    const response = await app.request(`/api/tickets/${ticket.id}/start`, {
      method: 'POST',
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'Display-only mock tickets cannot be started',
    })
    expect(initializeTicket).not.toHaveBeenCalled()
    expect(getTicketByRef(ticket.id)).toMatchObject({
      status: 'DRAFT',
      branchName: DISPLAY_ONLY_MOCK_BRANCH_NAME,
    })
  })

  it('rejects a concurrent start while the first request validates models', async () => {
    const { app, ticket } = setupStartTicketApp()
    let validationStarted!: () => void
    let finishValidation!: (value: Awaited<ReturnType<typeof validateModelSelection>>) => void
    const started = new Promise<void>((resolve) => { validationStarted = resolve })
    const validation = new Promise<Awaited<ReturnType<typeof validateModelSelection>>>((resolve) => { finishValidation = resolve })
    vi.mocked(validateModelSelection).mockImplementationOnce(() => {
      validationStarted()
      return validation
    })

    const firstStart = app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })
    await started
    const overlappingStart = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

    expect(overlappingStart.status).toBe(429)
    expect(await overlappingStart.json()).toEqual({ error: 'Ticket start is already in progress' })

    finishValidation({
      mainImplementer: 'openai/codex-mini-latest',
      councilMembers: ['openai/codex-mini-latest', 'openai/gpt-5.3-codex'],
    })
    expect((await firstStart).status).toBe(200)
    broadcaster.clearTicket(ticket.id)
  })

  it('restores DRAFT when the start configuration lock reports that the ticket is missing', async () => {
    const { app, ticket } = setupStartTicketApp()
    vi.spyOn(ticketStorage, 'lockTicketStartConfiguration').mockReturnValueOnce(undefined)

    const response = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Ticket not found' })
    expect(getTicketByRef(ticket.id)).toMatchObject({
      status: 'DRAFT',
      branchName: null,
      startedAt: null,
      lockedMainImplementer: null,
      lockedCouncilMembers: [],
    })
    expect(stopActor).toHaveBeenCalledWith(ticket.id)
    expect(sendTicketEvent).not.toHaveBeenCalled()
    broadcaster.clearTicket(ticket.id)
  })

  it.each(['undefined', 'throws'])('stops a draft actor when rollback %s after a failed start', async (rollbackResult) => {
    const { app, ticket } = setupStartTicketApp()
    vi.spyOn(ticketStorage, 'lockTicketStartConfiguration').mockReturnValueOnce(undefined)
    const rollbackSpy = vi.spyOn(ticketStorage, 'rollbackTicketStartConfiguration')
    if (rollbackResult === 'throws') {
      rollbackSpy.mockImplementationOnce(() => { throw new Error('Metadata rollback failed') })
    } else {
      rollbackSpy.mockReturnValueOnce(undefined)
    }

    const response = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

    expect(response.status).toBe(404)
    expect(stopActor).toHaveBeenCalledWith(ticket.id)
    expect(sendTicketEvent).not.toHaveBeenCalled()
    broadcaster.clearTicket(ticket.id)
  })

  it('keeps a draft retryable when writing the ticket metadata lock fails', async () => {
    const { app, ticket } = setupStartTicketApp()
    const ticketPaths = getTicketPaths(ticket.id)!
    const metadataPath = join(ticketPaths.ticketDir, 'meta', 'ticket.meta.json')
    const init = {
      worktreePath: ticketPaths.worktreePath,
      ticketDir: ticketPaths.ticketDir,
      branchName: ticket.externalId,
      baseBranch: 'main',
      reused: true,
    }
    vi.mocked(initializeTicket).mockResolvedValueOnce(init)
    vi.spyOn(ticketFileStorage, 'writeProjectTicketFile').mockImplementationOnce(() => {
      expect(getTicketByRef(ticket.id)).toMatchObject({
        status: 'DRAFT',
        lockedMainImplementer: 'openai/codex-mini-latest',
      })
      throw new Error('Metadata volume is temporarily unavailable')
    })

    const failedStart = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

    expect({ status: failedStart.status, body: await failedStart.json() }).toMatchObject({
      status: 500,
      body: { error: 'Failed to persist ticket start configuration' },
    })
    expect(getTicketByRef(ticket.id)).toMatchObject({
      status: 'DRAFT',
      branchName: null,
      startedAt: null,
      lockedMainImplementer: null,
      lockedCouncilMembers: [],
    })
    expect(stopActor).toHaveBeenCalledWith(ticket.id)
    expect(sendTicketEvent).not.toHaveBeenCalled()

    vi.mocked(initializeTicket).mockResolvedValueOnce(init)
    const retriedStart = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

    expect(retriedStart.status).toBe(200)
    expect(getTicketByRef(ticket.id)).toMatchObject({ status: 'SCANNING_RELEVANT_FILES' })
    expect(JSON.parse(readFileSync(metadataPath, 'utf8'))).toMatchObject({
      lockedMainImplementer: 'openai/codex-mini-latest',
    })
    broadcaster.clearTicket(ticket.id)
  })

  it('rejects malformed saved council variant data before locking a start', async () => {
    sqlite.exec(`
      INSERT INTO profiles (main_implementer, council_members, council_member_variants)
      VALUES ('openai/codex-mini-latest', '["openai/codex-mini-latest"]', '[]');
    `)
    const { app, ticket } = setupStartTicketApp()
    vi.mocked(initializeTicket).mockResolvedValueOnce({
      worktreePath: '/worktree',
      ticketDir: '/ticket',
      branchName: ticket.externalId,
      baseBranch: 'main',
      reused: false,
    })

    const response = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid configuration: malformed councilMemberVariants' })
    expect(getTicketByRef(ticket.id)).toMatchObject({ status: 'DRAFT', branchName: null, lockedCouncilMemberVariants: null })
    expect(sendTicketEvent).not.toHaveBeenCalled()
  })

  it('rejects ticket start before routing config writes while another prompt is active', async () => {
    const directory = makeTempDir('looptroop-ticket-start-busy-')
    const configPath = `${directory}/opencode.json`
    vi.stubEnv(LOOPTROOP_OPENCODE_ROUTING_CONFIG, configPath)
    mockGetOpenCodeConnection.mockResolvedValue({ protocol: 'v2', version: '2.0.16', headers: {} })
    vi.mocked(validateModelSelection).mockResolvedValue({
      mainImplementer: 'openrouter/deepseek/deepseek-v4-flash:floor',
      councilMembers: ['openrouter/deepseek/deepseek-v4-flash:floor'],
    })
    const { app, ticket } = setupStartTicketApp()
    const releasePrompt = beginOpenCodePromptActivity()

    try {
      const response = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        code: 'OPENCODE_BUSY',
        error: expect.stringContaining('active work'),
      })
      expect(getTicketByRef(ticket.id)).toMatchObject({ status: 'DRAFT', branchName: null })
      expect(initializeTicket).not.toHaveBeenCalled()
      expect(() => readFileSync(configPath, 'utf8')).toThrow()
    } finally {
      releasePrompt()
      removeTempDir(directory)
    }
  })

  it('starts with an already registered routing model while another prompt is active', async () => {
    const directory = makeTempDir('looptroop-ticket-start-routing-present-')
    const configPath = `${directory}/opencode.json`
    const originalConfig = {
      providers: {
        openrouter: {
          models: { 'deepseek/deepseek-v4-flash:floor': { keep: true } },
        },
      },
    }
    writeFileSync(configPath, JSON.stringify(originalConfig))
    vi.stubEnv(LOOPTROOP_OPENCODE_ROUTING_CONFIG, configPath)
    mockGetOpenCodeConnection.mockResolvedValue({ protocol: 'v2', version: '2.0.16', headers: {} })
    vi.mocked(validateModelSelection).mockResolvedValue({
      mainImplementer: 'openrouter/deepseek/deepseek-v4-flash:floor',
      councilMembers: ['openrouter/deepseek/deepseek-v4-flash:floor'],
    })
    const { app, ticket } = setupStartTicketApp()
    vi.mocked(initializeTicket).mockResolvedValueOnce({
      worktreePath: '/worktree',
      ticketDir: '/ticket',
      branchName: ticket.externalId,
      baseBranch: 'main',
      reused: true,
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const releasePrompt = beginOpenCodePromptActivity()

    try {
      const response = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

      expect(response.status).toBe(200)
      expect(getTicketByRef(ticket.id)?.status).toBe('SCANNING_RELEVANT_FILES')
      expect(initializeTicket).toHaveBeenCalledOnce()
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(originalConfig)
    } finally {
      releasePrompt()
      removeTempDir(directory)
    }
  })

  it('locks the configured structured retry count at ticket start', async () => {
    sqlite.exec(`
      INSERT INTO profiles (
        main_implementer,
        council_members,
        structured_retry_count
      ) VALUES (
        'openai/codex-mini-latest',
        '["openai/codex-mini-latest","openai/gpt-5.3-codex"]',
        4
      );
    `)

    const { app, ticket } = setupStartTicketApp()

    const response = await app.request(`/api/tickets/${ticket.id}/start`, {
      method: 'POST',
    })

    expect(response.status).toBe(200)
    expect(getTicketByRef(ticket.id)?.lockedStructuredRetryCount).toBe(4)

    broadcaster.clearTicket(ticket.id)
  })

  it('freezes the effective Manual QA value and its inheritance source at start', async () => {
    sqlite.exec(`
      INSERT INTO profiles (main_implementer, council_members, manual_qa_enabled)
      VALUES ('openai/codex-mini-latest', '["openai/codex-mini-latest"]', 1);
    `)
    const inherited = setupStartTicketApp()
    expect((await inherited.app.request(`/api/tickets/${inherited.ticket.id}/start`, { method: 'POST' })).status).toBe(200)
    expect(getTicketByRef(inherited.ticket.id)).toMatchObject({
      lockedManualQaEnabled: true,
      lockedManualQaSource: 'project',
    })

    const projectOverride = setupStartTicketApp()
    updateProject(projectOverride.project.id, { manualQaOverride: false })
    expect((await projectOverride.app.request(`/api/tickets/${projectOverride.ticket.id}/start`, { method: 'POST' })).status).toBe(200)
    expect(getTicketByRef(projectOverride.ticket.id)).toMatchObject({
      lockedManualQaEnabled: false,
      lockedManualQaSource: 'project',
    })

    const overridden = setupStartTicketApp()
    updateProject(overridden.project.id, { manualQaOverride: false })
    updateTicket(overridden.ticket.id, { manualQaOverride: true })
    expect((await overridden.app.request(`/api/tickets/${overridden.ticket.id}/start`, { method: 'POST' })).status).toBe(200)
    expect(getTicketByRef(overridden.ticket.id)).toMatchObject({
      lockedManualQaEnabled: true,
      lockedManualQaSource: 'ticket',
    })

    broadcaster.clearTicket(inherited.ticket.id)
    broadcaster.clearTicket(projectOverride.ticket.id)
    broadcaster.clearTicket(overridden.ticket.id)
  })

  it('freezes the saved project Git hook policy at start', async () => {
    sqlite.exec(`
      INSERT INTO profiles (main_implementer, council_members, git_hook_policy)
      VALUES ('openai/codex-mini-latest', '["openai/codex-mini-latest"]', 'observe_only');
    `)
    const inherited = setupStartTicketApp()
    expect((await inherited.app.request(`/api/tickets/${inherited.ticket.id}/start`, { method: 'POST' })).status).toBe(200)
    expect(getTicketByRef(inherited.ticket.id)).toMatchObject({
      lockedGitHookPolicy: 'observe_only',
      lockedGitHookPolicySource: 'project',
    })

    const projectOverride = setupStartTicketApp()
    updateProject(projectOverride.project.id, { gitHookPolicy: 'use_native_hooks' })
    expect((await projectOverride.app.request(`/api/tickets/${projectOverride.ticket.id}/start`, { method: 'POST' })).status).toBe(200)
    expect(getTicketByRef(projectOverride.ticket.id)).toMatchObject({
      lockedGitHookPolicy: 'use_native_hooks',
      lockedGitHookPolicySource: 'project',
    })

    broadcaster.clearTicket(inherited.ticket.id)
    broadcaster.clearTicket(projectOverride.ticket.id)
  })

  it('writes a DRAFT error log when model validation fails and leaves the ticket in DRAFT', async () => {
    const { app, ticket } = setupStartTicketApp()

    vi.mocked(validateModelSelection).mockRejectedValueOnce(
      new Error('No configured OpenCode models are available.'),
    )

    const response = await app.request(`/api/tickets/${ticket.id}/start`, {
      method: 'POST',
    })

    expect(response.status).toBe(400)
    const payload = await response.json() as { error?: string }
    expect(payload.error).toBe('No configured OpenCode models are available.')
    expect(getTicketByRef(ticket.id)?.status).toBe('DRAFT')

    expect(getDraftLogMessages(ticket.id)).toEqual([
      'Start requested.',
      'Validating model availability.',
      '✗ Model Availability: No configured OpenCode models are available.',
    ])

    broadcaster.clearTicket(ticket.id)
  })

  it('writes a DRAFT initialization error log before blocking the ticket', async () => {
    const { app, ticket } = setupStartTicketApp()

    vi.mocked(initializeTicket).mockImplementationOnce(() => {
      throw new TicketInitializationError('INIT_TEST', 'Worktree initialization exploded.')
    })

    const response = await app.request(`/api/tickets/${ticket.id}/start`, {
      method: 'POST',
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { status?: string; message?: string; details?: string }
    expect(payload).toMatchObject({
      status: 'BLOCKED_ERROR',
      message: 'Start blocked during initialization',
      details: 'Worktree initialization exploded.',
    })
    expect(getTicketByRef(ticket.id)?.status).toBe('BLOCKED_ERROR')

    expect(getDraftLogMessages(ticket.id)).toEqual([
      'Start requested.',
      'Validating model availability.',
      '✓ Model Availability: Main implementer openai/codex-mini-latest; council size 3.',
      'Initializing workspace and ticket directories.',
      '✗ Workspace Init: Worktree initialization exploded.',
    ])

    broadcaster.clearTicket(ticket.id)
  })

  it('returns an initialization error when INIT_FAILED cannot be dispatched', async () => {
    const { app, ticket } = setupStartTicketApp()
    vi.mocked(initializeTicket).mockRejectedValueOnce(new Error('Worktree initialization exploded.'))
    vi.mocked(sendTicketEvent).mockImplementationOnce(() => {
      throw new Error('Actor is unavailable')
    })

    const response = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: 'Failed to block ticket after initialization error',
      details: 'Actor is unavailable',
    })
    expect(getTicketByRef(ticket.id)?.status).toBe('DRAFT')
    expect(getDraftLogMessages(ticket.id)).toContain('Failed to block ticket after initialization error: Actor is unavailable')
    broadcaster.clearTicket(ticket.id)
  })

  it('stops an actor whose START advanced in memory but failed to persist', async () => {
    const { app, ticket } = setupStartTicketApp()
    // The actor advanced, but the mocked START dispatch fails before its persisted row changes.
    vi.mocked(getTicketState).mockReturnValue({ ...getTicketState(ticket.id)!, state: 'SCANNING_RELEVANT_FILES' })
    vi.mocked(sendTicketEvent).mockImplementationOnce(() => {
      throw new Error('Snapshot persistence failed')
    })
    const cancel = vi.spyOn(workflowRunner, 'cancelTicket')

    const response = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: 'Failed to start ticket',
      details: 'Snapshot persistence failed',
    })
    expect(getTicketByRef(ticket.id)).toMatchObject({
      status: 'DRAFT',
      branchName: null,
      startedAt: null,
      lockedMainImplementer: null,
      lockedCouncilMembers: [],
    })
    expect(cancel).toHaveBeenCalledWith(ticket.id)
    expect(stopActor).toHaveBeenCalledWith(ticket.id)
  })

  it('preserves a started actor when START persisted before dispatch threw', async () => {
    const { app, ticket } = setupStartTicketApp()
    vi.mocked(sendTicketEvent).mockImplementationOnce((ticketRef) => {
      ticketStorage.patchTicket(String(ticketRef), { status: 'SCANNING_RELEVANT_FILES' })
      throw new Error('START dispatch failed after persistence')
    })

    const response = await app.request(`/api/tickets/${ticket.id}/start`, { method: 'POST' })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: 'Failed to start ticket',
      details: 'START dispatch failed after persistence',
    })
    expect(getTicketByRef(ticket.id)).toMatchObject({
      status: 'SCANNING_RELEVANT_FILES',
      branchName: ticket.externalId,
      lockedMainImplementer: 'openai/codex-mini-latest',
      lockedCouncilMembers: [
        'openai/codex-mini-latest',
        'openai/gpt-5.3-codex',
        'anthropic/claude-sonnet-4',
      ],
    })
    expect(stopActor).not.toHaveBeenCalled()
  })
})
