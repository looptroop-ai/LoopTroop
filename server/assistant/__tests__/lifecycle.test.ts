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

const [{ db, closeDatabase, APP_CONFIG_DIR }, { appMeta, profiles }, { MockOpenCodeAdapter }, integration, sessions, ticketStorage, projectStorage, { getProjectDatabase }] = await Promise.all([
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
  return (JSON.parse(row!.value) as { openCodeSessionId: string }).openCodeSessionId
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

  it('deletes a ticket conversation and its OpenCode transcript while keeping unrelated history', async () => {
    const { ticket } = integration.createUninitializedTestTicket(repoManager)
    const scope = { mode: 'tickets' as const, ticketId: ticket.id }
    const session = await sessions.createAssistantSession(scope)
    const openCodeId = remoteId(session.id)
    const help = await sessions.createAssistantSession({ mode: 'help' })
    const dashboard = await sessions.createAssistantSession({ mode: 'tickets' })
    await sessions.closeAssistantSession(session.id, scope)

    expect(await ticketStorage.deleteTicket(ticket.id)).toBe(true)
    expect((await sessions.listAssistantSessions()).map(entry => entry.id).sort())
      .toEqual([help.id, dashboard.id].sort())
    await vi.waitFor(async () => {
      expect(await adapter.getSession(openCodeId)).toBeNull()
      expect(existsSync(join(APP_CONFIG_DIR, 'assistant', session.id))).toBe(false)
    })
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

  it('deletes dedicated conversations when deleting a project', async () => {
    const { ticket, project } = integration.createUninitializedTestTicket(repoManager)
    const session = await sessions.createAssistantSession({ mode: 'tickets', ticketId: ticket.id })
    const openCodeId = remoteId(session.id)

    expect(projectStorage.deleteProject(project.id)).toBe(true)
    expect(await sessions.listAssistantSessions()).toEqual([])
    await vi.waitFor(async () => expect(await adapter.getSession(openCodeId)).toBeNull())
  })

  it.each([
    ['clear tickets', projectStorage.clearExistingProjectTickets],
    ['replace project state', projectStorage.replaceExistingProjectState],
  ] as const)('does not resurrect an old conversation after %s reuses its ticket reference', async (_label, resetProject) => {
    const { ticket, project, repoDir } = integration.createUninitializedTestTicket(repoManager)
    const scope = { mode: 'tickets' as const, ticketId: ticket.id }
    const session = await sessions.createAssistantSession(scope)
    const openCodeId = remoteId(session.id)

    const reset = await resetProject({ folderPath: repoDir, name: project.name, shortname: project.shortname })
    const replacement = ticketStorage.createTicket({ projectId: reset.id, title: 'New ticket with reused reference' })

    expect(replacement.id).toBe(ticket.id)
    expect(await sessions.listAssistantSessions()).toEqual([])
    await expect(sessions.getAssistantSession(session.id, scope)).rejects.toMatchObject({ status: 404 })
    await vi.waitFor(async () => expect(await adapter.getSession(openCodeId)).toBeNull())
  })
})
