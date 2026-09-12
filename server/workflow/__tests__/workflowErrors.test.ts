import { rmSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenCodeUnavailableError, TicketWorkspaceNotInitializedError } from '../../lib/workflowErrors'
import { clearProjectDatabaseCache } from '../../db/project'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { makeTicketContext } from '../../test/factories'
import { loadTicketDirContext } from '../phases/ticketDirContext'

const { checkHealthMock } = vi.hoisted(() => ({ checkHealthMock: vi.fn() }))
vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => ({ checkHealth: checkHealthMock }),
  isMockOpenCodeMode: () => false,
}))

import { handleInterviewDeliberate } from '../phases/interviewPhase'

const repoManager = createTestRepoManager('workflow-errors-')

describe('workflow error throw boundaries', () => {
  beforeEach(() => {
    resetTestDb()
    checkHealthMock.mockReset()
  })
  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('types missing ticket context without changing its message', () => {
    const context = makeTicketContext()
    expect(() => loadTicketDirContext(context)).toThrow(TicketWorkspaceNotInitializedError)
    expect(() => loadTicketDirContext(context)).toThrow(`Ticket workspace not initialized: missing ticket context for ${context.externalId}`)
  })

  it('types missing ticket directories without changing their message', async () => {
    const { context, paths } = await createInitializedTestTicket(repoManager)
    rmSync(paths.ticketDir, { recursive: true, force: true })
    expect(() => loadTicketDirContext(context)).toThrow(TicketWorkspaceNotInitializedError)
    expect(() => loadTicketDirContext(context)).toThrow(`Ticket workspace not initialized: missing ticket directory for ${context.externalId}`)
  })

  it.each(['unavailable', 'rejected'])('types an %s health check without rewrapping its message', async (failure) => {
    const { context } = await createInitializedTestTicket(repoManager)
    if (failure === 'unavailable') checkHealthMock.mockResolvedValue({ available: false, error: 'connection refused' })
    else checkHealthMock.mockRejectedValue(new Error('connection refused'))

    const error = await handleInterviewDeliberate(context.ticketId, context, vi.fn(), new AbortController().signal)
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(OpenCodeUnavailableError)
    expect(error).toMatchObject({
      name: 'Error',
      message: 'OpenCode server is not running. Start it with `opencode serve`. (connection refused)',
    })
    expect(JSON.stringify(error)).toBe('{}')
  })
})
