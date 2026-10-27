import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

const { mockGetOpenCodeAdapter } = vi.hoisted(() => ({ mockGetOpenCodeAdapter: vi.fn() }))
vi.mock('../../opencode/factory', () => ({ getOpenCodeAdapter: mockGetOpenCodeAdapter }))

const previousConfigDir = process.env.LOOPTROOP_CONFIG_DIR
const configDir = makeTempDir('looptroop-assistant-lifecycle-')
process.env.LOOPTROOP_CONFIG_DIR = configDir

const [{ db, sqlite, closeDatabase, APP_CONFIG_DIR }, { appMeta, profiles }, { MockOpenCodeAdapter }, integration, sessions, ticketStorage, projectStorage, { getProjectDatabase }] = await Promise.all([
  import('../../db/index'),
  import('../../db/schema'),
  import('../../opencode/mockAdapter'),
  import('../../test/integration'),
  import('../sessions'),
  import('../../storage/tickets'),
  import('../../storage/projects'),
  import('../../db/project'),
])

const repoManager = integration.createTestRepoManager('assistant-lifecycle-')
let adapter: InstanceType<typeof MockOpenCodeAdapter>

function remoteId(id: string): string {
  const row = db.select().from(appMeta).all().find(entry => entry.key === `assistant.session.${id}`)
  if (!row) throw new Error(`Missing assistant session record: ${id}`)
  return (JSON.parse(row.value) as { openCodeSessionId: string }).openCodeSessionId
}

beforeEach(async () => {
  await rm(join(APP_CONFIG_DIR, 'assistant'), { recursive: true, force: true })
  integration.resetTestDb()
  db.delete(appMeta).run()
  db.insert(profiles).values({ chatModel: 'provider/assistant', saveChatSessions: true }).run()
  adapter = new MockOpenCodeAdapter()
  mockGetOpenCodeAdapter.mockReset().mockReturnValue(adapter)
})

afterAll(() => {
  closeDatabase()
  repoManager.cleanup()
  if (previousConfigDir === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
  else process.env.LOOPTROOP_CONFIG_DIR = previousConfigDir
  removeTempDir(configDir)
})

describe('assistant ticket and project lifecycle', () => {
  it.each(['delete', 'reset'] as const)('cleans a conversation created while its ticket is undergoing %s', async (operation) => {
    const { ticket, project, repoDir } = integration.createUninitializedTestTicket(repoManager)
    const createRemote = adapter.createSession.bind(adapter)
    const deleteRemote = vi.spyOn(adapter, 'deleteSession')
    adapter.createSession = async (...args) => {
      const remote = await createRemote(...args)
      if (operation === 'delete') await ticketStorage.deleteTicket(ticket.id)
      else {
        const reset = await projectStorage.clearExistingProjectTickets({ folderPath: repoDir, name: project.name, shortname: project.shortname })
        const replacement = ticketStorage.createTicket({ projectId: reset.id, title: 'Replacement ticket' })
        expect(replacement.id).toBe(ticket.id)
      }
      return remote
    }

    await expect(sessions.createAssistantSession({ mode: 'tickets', ticketId: ticket.id })).rejects.toMatchObject({ status: 404 })
    expect(await sessions.listAssistantSessions()).toEqual([])
    expect(deleteRemote).toHaveBeenCalledTimes(1)
    expect(await adapter.getSession(deleteRemote.mock.calls[0]?.[0] ?? '')).toBeNull()
    expect(await readdir(join(APP_CONFIG_DIR, 'assistant'))).toEqual([])
  })

  it('deletes a ticket conversation while keeping dashboard and unrelated history', async () => {
    const { ticket } = integration.createUninitializedTestTicket(repoManager)
    const scope = { mode: 'tickets' as const, ticketId: ticket.id }
    const session = await sessions.createAssistantSession(scope)
    const openCodeId = remoteId(session.id)
    const help = await sessions.createAssistantSession({ mode: 'help' })
    const dashboard = await sessions.createAssistantSession({ mode: 'tickets' })
    const dashboardOpenCodeId = remoteId(dashboard.id)
    await sessions.closeAssistantSession(session.id, scope)

    expect(await ticketStorage.deleteTicket(ticket.id)).toBe(true)
    expect((await sessions.listAssistantSessions()).map(entry => entry.id).sort())
      .toEqual([dashboard.id, help.id].sort())
    await vi.waitFor(async () => {
      expect(await adapter.getSession(openCodeId)).toBeNull()
      expect(existsSync(join(APP_CONFIG_DIR, 'assistant', session.id))).toBe(false)
      expect(await adapter.getSession(dashboardOpenCodeId)).not.toBeNull()
    })
    expect((await sessions.listAssistantSessions()).map(entry => entry.id).sort())
      .toEqual([dashboard.id, help.id].sort())
  })

  it('does not abort an active dashboard answer when its evidence ticket is deleted', async () => {
    const { ticket } = integration.createUninitializedTestTicket(repoManager)
    const dashboard = await sessions.createAssistantSession({ mode: 'tickets' })
    const dashboardOpenCodeId = remoteId(dashboard.id)
    let markPromptStarted!: () => void
    let releasePrompt!: () => void
    const promptStarted = new Promise<void>(resolve => { markPromptStarted = resolve })
    const promptHold = new Promise<void>(resolve => { releasePrompt = resolve })
    vi.spyOn(adapter, 'promptSession').mockImplementation(async () => {
      markPromptStarted()
      await promptHold
      return 'Answer based on the evidence prepared before deletion.'
    })
    const abortSession = vi.spyOn(adapter, 'abortSession')
    const prompt = sessions.promptAssistant(
      dashboard.id, { mode: 'tickets' }, 'Question about this ticket', new AbortController().signal, () => undefined,
    )
    const promptOutcome = prompt.then(session => session, error => error)

    await promptStarted
    const dashboardAbortCount = abortSession.mock.calls.filter(([id]) => id === dashboardOpenCodeId).length
    let deleted = false
    let abortCountAfterDelete = 0
    let dashboardSessionAfterDelete: Awaited<ReturnType<typeof adapter.getSession>> = null
    try {
      deleted = await ticketStorage.deleteTicket(ticket.id)
      abortCountAfterDelete = abortSession.mock.calls.filter(([id]) => id === dashboardOpenCodeId).length
      dashboardSessionAfterDelete = await adapter.getSession(dashboardOpenCodeId)
    } finally {
      releasePrompt()
    }

    expect(dashboardAbortCount).toBe(1)
    expect(deleted).toBe(true)
    expect(abortCountAfterDelete).toBe(dashboardAbortCount)
    expect(dashboardSessionAfterDelete).not.toBeNull()
    expect(await promptOutcome).toMatchObject({ id: dashboard.id, canResume: true })
    await expect(sessions.getAssistantSession(dashboard.id, { mode: 'tickets' }))
      .resolves.toMatchObject({ id: dashboard.id, canResume: true })
  })

  it.each([{ deleteContent: true }, { deleteLog: true }])('deletes ticket conversations but keeps dashboard history when canceled ticket data is removed (%j)', async (options) => {
    const { ticket } = integration.createUninitializedTestTicket(repoManager)
    const session = await sessions.createAssistantSession({ mode: 'tickets', ticketId: ticket.id })
    const ticketOpenCodeId = remoteId(session.id)
    const dashboard = await sessions.createAssistantSession({ mode: 'tickets' })
    const dashboardOpenCodeId = remoteId(dashboard.id)
    const help = await sessions.createAssistantSession({ mode: 'help' })

    expect(await ticketStorage.cleanupCanceledTicketData(ticket.id, options)).toBe(true)
    expect((await sessions.listAssistantSessions()).map(entry => entry.id).sort())
      .toEqual([dashboard.id, help.id].sort())
    expect(ticketStorage.getTicketByRef(ticket.id)).toBeDefined()
    await vi.waitFor(async () => {
      expect(await adapter.getSession(ticketOpenCodeId)).toBeNull()
      expect(await adapter.getSession(dashboardOpenCodeId)).not.toBeNull()
    })
    expect((await sessions.listAssistantSessions()).map(entry => entry.id).sort())
      .toEqual([dashboard.id, help.id].sort())
  })

  it('continues ticket and project cleanup when assistant cleanup receipt inserts fail', async () => {
    const { ticket, project, repoDir } = integration.createUninitializedTestTicket(repoManager)
    await sessions.createAssistantSession({ mode: 'tickets', ticketId: ticket.id })
    const worktreePath = join(repoDir, '.looptroop', 'worktrees', ticket.externalId)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    sqlite.exec(`
      CREATE TRIGGER block_assistant_cleanup_receipts
      BEFORE INSERT ON app_meta
      WHEN NEW.key LIKE 'assistant.cleanup.%'
      BEGIN SELECT RAISE(ABORT, 'cleanup queue blocked'); END
    `)

    try {
      expect(existsSync(worktreePath)).toBe(true)
      expect(await ticketStorage.deleteTicket(ticket.id)).toBe(true)
      expect(existsSync(worktreePath)).toBe(false)

      const nextTicket = ticketStorage.createTicket({ projectId: project.id, title: 'Reset after cleanup queue failure' })
      await sessions.createAssistantSession({ mode: 'tickets', ticketId: nextTicket.id })
      const reset = await projectStorage.clearExistingProjectTickets({
        folderPath: repoDir,
        name: project.name,
        shortname: project.shortname,
      })

      expect(reset.id).toBe(project.id)
      expect(projectStorage.getProjectContextById(reset.id)).toBeDefined()
      expect(projectStorage.listProjectTickets(reset.id)).toHaveLength(0)
      expect(projectStorage.deleteProject(reset.id)).toBe(true)
      expect(projectStorage.getProjectRootById(reset.id)).toBeUndefined()
      expect(warn).toHaveBeenCalled()
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS block_assistant_cleanup_receipts')
      warn.mockRestore()
    }
  })

  it('keeps conversations when the ticket deletion transaction fails', async () => {
    const { ticket, repoDir } = integration.createUninitializedTestTicket(repoManager)
    const scope = { mode: 'tickets' as const, ticketId: ticket.id }
    const session = await sessions.createAssistantSession(scope)
    const openCodeId = remoteId(session.id)
    getProjectDatabase(repoDir).sqlite.exec("CREATE TRIGGER prevent_ticket_delete BEFORE DELETE ON tickets BEGIN SELECT RAISE(ABORT, 'delete blocked'); END")

    await expect(ticketStorage.deleteTicket(ticket.id)).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'delete blocked' }) })
    await expect(sessions.getAssistantSession(session.id, scope)).resolves.toMatchObject({ id: session.id, canResume: true })
    expect(await adapter.getSession(openCodeId)).not.toBeNull()
  })

  it('deletes project conversations while keeping dashboard history', async () => {
    const { ticket, project } = integration.createUninitializedTestTicket(repoManager)
    const session = await sessions.createAssistantSession({ mode: 'tickets', ticketId: ticket.id })
    const openCodeId = remoteId(session.id)
    const dashboard = await sessions.createAssistantSession({ mode: 'tickets' })
    const dashboardOpenCodeId = remoteId(dashboard.id)

    expect(projectStorage.deleteProject(project.id)).toBe(true)
    expect((await sessions.listAssistantSessions()).map(entry => entry.id)).toEqual([dashboard.id])
    await vi.waitFor(async () => {
      expect(await adapter.getSession(openCodeId)).toBeNull()
      expect(await adapter.getSession(dashboardOpenCodeId)).not.toBeNull()
    })
  })

  it.each([
    ['clear tickets', projectStorage.clearExistingProjectTickets],
    ['replace project state', projectStorage.replaceExistingProjectState],
  ] as const)('does not resurrect an old conversation after %s reuses its ticket reference', async (_label, resetProject) => {
    const { ticket, project, repoDir } = integration.createUninitializedTestTicket(repoManager)
    const scope = { mode: 'tickets' as const, ticketId: ticket.id }
    const session = await sessions.createAssistantSession(scope)
    const openCodeId = remoteId(session.id)
    const dashboard = await sessions.createAssistantSession({ mode: 'tickets' })
    const dashboardOpenCodeId = remoteId(dashboard.id)

    const reset = await resetProject({ folderPath: repoDir, name: project.name, shortname: project.shortname })
    const replacement = ticketStorage.createTicket({ projectId: reset.id, title: 'New ticket with reused reference' })

    expect(replacement.id).toBe(ticket.id)
    expect((await sessions.listAssistantSessions()).map(entry => entry.id)).toEqual([dashboard.id])
    await expect(sessions.getAssistantSession(session.id, scope)).rejects.toMatchObject({ status: 404 })
    await vi.waitFor(async () => {
      expect(await adapter.getSession(openCodeId)).toBeNull()
      expect(await adapter.getSession(dashboardOpenCodeId)).not.toBeNull()
    })
  })
})
