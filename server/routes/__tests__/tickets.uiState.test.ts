import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import { createTicket } from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { ticketRouter } from '../tickets'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-ticket-ui-state-route-',
  files: {
    'README.md': '# LoopTroop Ticket UI State Route Test\n',
  },
})

function createUiStateTicket() {
  const repoDir = repoManager.createRepo()
  const project = attachProject({
    folderPath: repoDir,
    name: 'UI State Route',
    shortname: 'UI',
  })
  return createTicket({
    projectId: project.id,
    title: 'Persist UI state',
    description: 'Regression coverage for UI state revisions.',
  })
}

describe('ticketRouter UI state revisions', () => {
  const app = new Hono()
  app.route('/api', ticketRouter)

  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('rejects stale compare-and-set revisions and returns the latest state', async () => {
    const ticket = createUiStateTicket()
    const path = `/api/tickets/${encodeURIComponent(ticket.id)}/ui-state`

    const newer = await app.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'workspace',
        data: { selected: 'newer' },
        expectedRevision: 0,
        actionId: 'save-newer',
      }),
    })
    expect(newer.status).toBe(200)

    const stale = await app.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'workspace',
        data: { selected: 'stale' },
        expectedRevision: 0,
        actionId: 'save-stale',
      }),
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({
      conflict: true,
      data: { selected: 'newer' },
      revision: 1,
    })

    const response = await app.request(`${path}?scope=workspace`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: { selected: 'newer' },
      revision: 1,
      clientRevision: 1,
    })
  })

  it('treats a repeated action ID as an idempotent retry', async () => {
    const ticket = createUiStateTicket()
    const path = `/api/tickets/${encodeURIComponent(ticket.id)}/ui-state`
    const payload = {
      scope: 'workspace',
      data: { selected: 'same' },
      expectedRevision: 0,
      actionId: 'save-once',
    }

    expect((await app.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })).status).toBe(200)

    const retry = await app.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ conflict: false, revision: 1 })
  })

  it('rejects a repeated action ID when its content differs', async () => {
    const ticket = createUiStateTicket()
    const path = `/api/tickets/${encodeURIComponent(ticket.id)}/ui-state`

    expect((await app.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'workspace',
        data: { selected: 'original' },
        expectedRevision: 0,
        actionId: 'save-once',
      }),
    })).status).toBe(200)

    const conflictingReplay = await app.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'workspace',
        data: { selected: 'different' },
        expectedRevision: 0,
        actionId: 'save-once',
      }),
    })
    expect(conflictingReplay.status).toBe(409)
    expect(await conflictingReplay.json()).toMatchObject({
      conflict: true,
      data: { selected: 'original' },
      revision: 1,
    })
  })

  it('keeps the dev-event endpoint disabled unless explicitly configured', async () => {
    const previousEnabled = process.env.LOOPTROOP_ENABLE_DEV_EVENT
    const previousToken = process.env.LOOPTROOP_DEV_EVENT_TOKEN
    delete process.env.LOOPTROOP_ENABLE_DEV_EVENT
    delete process.env.LOOPTROOP_DEV_EVENT_TOKEN

    try {
      const ticket = createUiStateTicket()
      const response = await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/dev-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'READY' }),
      })

      expect(response.status).toBe(404)
    } finally {
      if (previousEnabled === undefined) delete process.env.LOOPTROOP_ENABLE_DEV_EVENT
      else process.env.LOOPTROOP_ENABLE_DEV_EVENT = previousEnabled
      if (previousToken === undefined) delete process.env.LOOPTROOP_DEV_EVENT_TOKEN
      else process.env.LOOPTROOP_DEV_EVENT_TOKEN = previousToken
    }
  })

  it('exposes an aggregate OpenCode questions endpoint', async () => {
    const response = await app.request('/api/opencode/questions')

    expect(response.status).toBe(200)
    // `timers` is keyed by ticket, and is empty for the same reason `questions`
    // is: the countdown only exists while a question does.
    expect(await response.json()).toEqual({ questions: [], timers: {} })
  })
})
