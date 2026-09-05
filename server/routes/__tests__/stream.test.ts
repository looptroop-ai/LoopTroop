import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import { createTicket } from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { broadcaster } from '../../sse/broadcaster'
import { MAX_SSE_CONNECTIONS_PER_TICKET, streamRouter } from '../stream'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-stream-route-',
  files: {
    'README.md': '# LoopTroop Stream Route Test\n',
  },
})

function createStreamRouteTicket() {
  const repoDir = repoManager.createRepo()
  const project = attachProject({
    folderPath: repoDir,
    name: 'Stream Route',
    shortname: 'SSE',
  })
  return createTicket({
    projectId: project.id,
    title: 'Stream ticket',
    description: 'Regression coverage for stream validation.',
  })
}

describe('streamRouter', () => {
  const app = new Hono()
  app.route('/api', streamRouter)

  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('rejects unknown ticket IDs before opening an SSE stream', async () => {
    const response = await app.request('/api/stream?ticketId=missing-ticket')

    expect(response.status).toBe(404)
  })

  it('rejects streams over the per-ticket connection cap', async () => {
    const ticket = createStreamRouteTicket()
    for (let index = 0; index < MAX_SSE_CONNECTIONS_PER_TICKET; index += 1) {
      broadcaster.addClient(ticket.id, {
        id: `client-${index}`,
        send: vi.fn(),
        close: vi.fn(),
      })
    }

    const response = await app.request(`/api/stream?ticketId=${encodeURIComponent(ticket.id)}`)

    expect(response.status).toBe(429)
    broadcaster.clearTicket(ticket.id)
  })
})
