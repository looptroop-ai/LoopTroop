import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { ticketRouter } from '../tickets'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-ticket-route-create-',
  files: {
    'README.md': '# LoopTroop Ticket Route Create Test\n',
  },
})

function setupCreateTicketApp() {
  const repoDir = repoManager.createRepo()
  const project = attachProject({
    folderPath: repoDir,
    name: 'LoopTroop',
    shortname: 'LOOP',
  })
  const app = new Hono()
  app.route('/api', ticketRouter)

  return { app, project }
}

describe('ticketRouter POST /tickets', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('returns 400 for oversized ticket descriptions instead of leaking a storage validation error', async () => {
    const { app, project } = setupCreateTicketApp()

    const response = await app.request('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        title: 'Oversized description',
        description: 'x'.repeat(50_001),
      }),
    })

    expect(response.status).toBe(400)
    const payload = await response.json() as { error?: string; message?: string }
    expect(payload.error).toBe('Invalid input')
    expect(payload.message).toContain('description')
  })
})
