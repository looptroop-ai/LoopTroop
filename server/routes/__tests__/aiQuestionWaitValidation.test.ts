import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { profileRouter } from '../profiles'
import { projectRouter } from '../projects'
import { ticketRouter } from '../tickets'

const createWaitValidationApp = () => {
  const app = new Hono()
  app.route('/api', profileRouter)
  app.route('/api', projectRouter)
  app.route('/api', ticketRouter)
  return app
}

describe.each([
  { name: 'profile create', method: 'POST', url: '/api/profile', field: 'aiQuestionWindow', body: {} },
  { name: 'profile update', method: 'PATCH', url: '/api/profile', field: 'aiQuestionWindow', body: {} },
  { name: 'project create', method: 'POST', url: '/api/projects', field: 'aiQuestionWindowOverride', body: { folderPath: 'unused-fixture', name: 'Wait validation', shortname: 'WAIT' } },
  { name: 'project update', method: 'PATCH', url: '/api/projects/1', field: 'aiQuestionWindowOverride', body: {} },
  { name: 'ticket create', method: 'POST', url: '/api/tickets', field: 'aiQuestionWindowOverride', body: { projectId: 1, title: 'Wait validation' } },
  { name: 'ticket update', method: 'PATCH', url: '/api/tickets/1:WAIT-1', field: 'aiQuestionWindowOverride', body: {} },
])('$name whole-minute wait validation', ({ method, url, field, body }) => {
  it.each([60_001, 90_000])('rejects %i ms at the request boundary', async value => {
    const app = createWaitValidationApp()
    const response = await app.request(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, [field]: value }),
    })

    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toContain(field)
  })
})
