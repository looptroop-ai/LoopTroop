import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { clearProjectDatabaseCache } from '../../db/project'
import { sqlite } from '../../db/index'
import { appendLogEvent } from '../../log/executionLog'
import { ticketRouter } from '../tickets'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'

const repoManager = createTestRepoManager('log-projection-')
const app = new Hono()
app.route('/api', ticketRouter)

beforeEach(() => {
  clearProjectDatabaseCache()
  resetTestDb()
})

afterAll(() => {
  clearProjectDatabaseCache()
  repoManager.cleanup()
  sqlite.close()
})

describe('ticket log projection API', () => {
  it('returns newest matching rows first, pages older rows, and exports complete history', async () => {
    const { ticket } = createInitializedTestTicket(repoManager)
    for (let index = 0; index < 4; index += 1) {
      appendLogEvent(ticket.id, 'info', 'CODING', `row-${index}`, { timestamp: `2026-01-01T00:00:0${index}.000Z` }, 'system', 'CODING')
    }

    const first = await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&view=overview&limit=2`)
    expect(first.status).toBe(200)
    const firstBody = await first.json() as { entries: Array<{ content: string }>; hasOlder: boolean; olderCursor: string }
    expect(firstBody.entries.map(entry => entry.content)).toEqual(['row-2', 'row-3'])
    expect(firstBody.hasOlder).toBe(true)

    const older = await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&view=overview&limit=2&before=${encodeURIComponent(firstBody.olderCursor)}`)
    expect((await older.json() as { entries: Array<{ content: string }> }).entries.map(entry => entry.content)).toEqual(['row-0', 'row-1'])

    const exported = await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs/export?scope=phase&phase=CODING&view=overview`)
    expect(exported.headers.get('content-type')).toContain('text/plain')
    expect((await exported.text()).split('\n').map(line => line.slice(-5))).toEqual(['row-0', 'row-1', 'row-2', 'row-3'])
  })

  it('uses the shared classification for command, error, AI, and debug views', async () => {
    const { ticket } = createInitializedTestTicket(repoManager)
    appendLogEvent(ticket.id, 'info', 'CODING', '[CMD] $ npm test', {}, 'system', 'CODING')
    appendLogEvent(ticket.id, 'error', 'CODING', 'failed', {}, 'error', 'CODING')
    appendLogEvent(ticket.id, 'model_output', 'CODING', 'thinking', { audience: 'ai', modelId: 'test/model' }, 'opencode', 'CODING')
    appendLogEvent(ticket.id, 'debug', 'CODING', 'trace', {}, 'debug', 'CODING')

    for (const [view, expected] of [['command', '[CMD] $ npm test'], ['error', 'failed'], ['ai', 'thinking'], ['debug', 'trace']] as const) {
      const response = await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=lifecycle&view=${view}`)
      expect(response.status).toBe(200)
      expect((await response.json() as { entries: Array<{ content: string }> }).entries.map(entry => entry.content)).toContain(expected)
    }
  })
})
