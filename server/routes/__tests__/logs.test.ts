import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { appendFileSync } from 'node:fs'
import { clearProjectDatabaseCache } from '../../db/project'
import { sqlite } from '../../db/index'
import { appendLogEvent } from '../../log/executionLog'
import { ticketRouter } from '../tickets'
import { health } from '../health'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { getTicketPaths } from '../../storage/tickets'

const repoManager = createTestRepoManager('log-projection-')
const app = new Hono()
app.route('/api', ticketRouter)
app.route('/api', health)

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
  it('defaults to the newest 20 projected rows without reading the complete history', async () => {
    const { ticket } = createInitializedTestTicket(repoManager)
    for (let index = 0; index < 300; index += 1) {
      appendLogEvent(ticket.id, 'info', 'CODING', `row-${index}`, { timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z` }, 'system', 'CODING')
    }

    const response = await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&view=overview`)
    expect(response.status).toBe(200)
    const body = await response.json() as { entries: Array<{ content: string }>; hasOlder: boolean; olderCursor: string }
    expect(body.entries).toHaveLength(20)
    expect(body.entries[0]?.content).toBe('row-280')
    expect(body.entries.at(-1)?.content).toBe('row-299')
    expect(body.hasOlder).toBe(true)
    expect(body.olderCursor).toEqual(expect.any(String))
  })

  it('keeps health responsive and deduplicates readers during a cold projection catch-up', async () => {
    const { ticket } = createInitializedTestTicket(repoManager)
    const paths = getTicketPaths(ticket.id)
    expect(paths).not.toBeNull()
    const lines = Array.from({ length: 2_000 }, (_, index) => JSON.stringify({
      timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      type: 'info',
      ticketId: ticket.id,
      phase: 'CODING',
      phaseAttempt: 1,
      status: 'CODING',
      source: 'system',
      message: `cold-${index}`,
      content: `cold-${index}`,
    })).join('\n') + '\n'
    appendFileSync(paths!.executionLogPath, lines)

    const firstHistory = app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&view=overview`)
    const secondHistory = app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&view=overview`)
    const healthResponse = await app.request('/api/health')
    expect(healthResponse.status).toBe(200)
    expect(await healthResponse.json()).toEqual(expect.objectContaining({ status: 'ok' }))

    const [first, second] = await Promise.all([firstHistory, secondHistory])
    const firstBody = await first.json() as { entries: Array<{ content: string }> }
    const secondBody = await second.json() as { entries: Array<{ content: string }> }
    expect(firstBody.entries).toHaveLength(20)
    expect(secondBody.entries).toEqual(firstBody.entries)
    expect(firstBody.entries.at(-1)?.content).toBe('cold-1999')
  })

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

  it('shows one AI provider error in both the model transcript and ERROR history', async () => {
    const { ticket } = createInitializedTestTicket(repoManager)
    appendLogEvent(
      ticket.id,
      'error',
      'CODING',
      'Provider recovery required. Reason: overloaded',
      { audience: 'ai', kind: 'error', modelId: 'test/model' },
      'model:test/model',
      'CODING',
    )

    const modelResponse = await app.request(
      `/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=lifecycle&view=ai&modelId=${encodeURIComponent('test/model')}`,
    )
    const errorResponse = await app.request(
      `/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=lifecycle&view=error`,
    )
    const expected = 'Provider recovery required. Reason: overloaded'
    expect((await modelResponse.json() as { entries: Array<{ content: string }> }).entries.map(entry => entry.content)).toEqual([expected])
    expect((await errorResponse.json() as { entries: Array<{ content: string }> }).entries.map(entry => entry.content)).toEqual([expected])
  })
})
