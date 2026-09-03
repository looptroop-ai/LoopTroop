import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { appendFileSync } from 'node:fs'
import { clearProjectDatabaseCache } from '../../db/project'
import { sqlite } from '../../db/index'
import { appendLogEvent } from '../../log/executionLog'
import { exportLogEntries } from '../../log/projection'
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
  /**
   * Three hundred separate appends, each a synchronous write to a real file,
   * and the count is what the assertions are about: the twenty newest of three
   * hundred, with older pages behind them. On Windows every one of those writes
   * carries the filesystem's per-write cost — the same eight tests take 1.2s
   * here and 37s on a hosted Windows runner — so this one crosses the shared
   * 20s budget while measuring platform I/O rather than the pagination it
   * exists to check. The rows cannot be reduced without changing what is
   * asserted, so the budget is raised for this test alone rather than for the
   * whole project, and rather than retrying a test that is not flaky.
   */
  it('defaults to the newest 20 projected rows without reading the complete history', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    for (let index = 0; index < 300; index += 1) {
      appendLogEvent(ticket.id, 'info', 'CODING', `row-${index}`, { timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z` }, 'system', 'CODING')
    }

    const response = await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&view=overview`)
    expect(response.status).toBe(200)
    const body = await response.json() as {
      entries: Array<{ content: string }>
      hasOlder: boolean
      olderCursor: string
      totalEntries: number
      totalTextLines: number
    }
    expect(body.entries).toHaveLength(20)
    expect(body.entries[0]?.content).toBe('row-280')
    expect(body.entries.at(-1)?.content).toBe('row-299')
    expect(body.hasOlder).toBe(true)
    expect(body.olderCursor).toEqual(expect.any(String))
    expect(body.totalEntries).toBe(300)
    expect(body.totalTextLines).toBe(300)
  }, 60_000)

  it('filters command chatter before paginating the overview', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    appendLogEvent(ticket.id, 'info', 'CODING', 'visible milestone', {}, 'system', 'CODING')
    for (let index = 0; index < 25; index += 1) {
      appendLogEvent(ticket.id, 'info', 'CODING', `[CMD] $ command-${index}`, {}, 'system', 'CODING')
    }

    const overview = await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&view=overview`)
    expect(overview.status).toBe(200)
    expect((await overview.json() as { entries: Array<{ content: string }> }).entries.map(entry => entry.content))
      .toEqual(['visible milestone'])

    const commands = await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&view=command`)
    expect(commands.status).toBe(200)
    const commandBody = await commands.json() as { entries: Array<{ content: string }>; hasOlder: boolean }
    expect(commandBody.entries).toHaveLength(20)
    expect(commandBody.entries.every(entry => entry.content.startsWith('[CMD]'))).toBe(true)
    expect(commandBody.hasOlder).toBe(true)
  })

  it('filters historical rows by bead id so completed bead transcripts remain addressable', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    appendLogEvent(ticket.id, 'model_output', 'CODING', 'older bead output', {
      audience: 'ai',
      kind: 'text',
      entryId: 'bead-1-output',
      beadId: 'bead-1',
      beadIteration: 1,
    }, 'opencode', 'CODING')
    appendLogEvent(ticket.id, 'model_output', 'CODING', 'other bead output', {
      audience: 'ai',
      kind: 'text',
      entryId: 'bead-2-output',
      beadId: 'bead-2',
      beadIteration: 1,
    }, 'opencode', 'CODING')

    const response = await app.request(
      `/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&view=ai&beadId=bead-1`,
    )
    expect(response.status).toBe(200)
    expect((await response.json() as { entries: Array<{ entryId: string }> }).entries.map((entry) => entry.entryId))
      .toEqual(['bead-1-output'])
  })

  it('filters AI detail-only rows before paginating the overview', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    for (let index = 0; index < 25; index += 1) {
      appendLogEvent(ticket.id, 'model_output', 'CODING', `tool detail ${index}`, {
        audience: 'ai',
        kind: 'tool',
        entryId: `tool-detail-${index}`,
      }, 'opencode', 'CODING')
    }
    appendLogEvent(ticket.id, 'info', 'CODING', 'visible milestone', {}, 'system', 'CODING')

    const overview = await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&view=overview`)
    expect(overview.status).toBe(200)
    expect(await overview.json()).toEqual(expect.objectContaining({
      entries: [expect.objectContaining({ content: 'visible milestone' })],
      totalEntries: 1,
      hasOlder: false,
    }))
  })

  it('keeps health responsive and deduplicates readers during a cold projection catch-up', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
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
    const { ticket } = await createInitializedTestTicket(repoManager)
    for (let index = 0; index < 4; index += 1) {
      appendLogEvent(ticket.id, 'info', 'CODING', `row-${index}`, { timestamp: `2026-01-01T00:00:0${index}.000Z` }, 'system', 'CODING')
    }

    const first = await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&view=overview&limit=2`)
    expect(first.status).toBe(200)
    const firstBody = await first.json() as {
      entries: Array<{ content: string }>
      hasOlder: boolean
      olderCursor: string
      totalEntries: number
      totalTextLines: number
    }
    expect(firstBody.entries.map(entry => entry.content)).toEqual(['row-2', 'row-3'])
    expect(firstBody.hasOlder).toBe(true)
    expect(firstBody.totalEntries).toBe(4)
    expect(firstBody.totalTextLines).toBe(4)

    const older = await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&view=overview&limit=2&before=${encodeURIComponent(firstBody.olderCursor)}`)
    const olderBody = await older.json() as {
      entries: Array<{ content: string }>
      totalEntries?: number
      totalTextLines?: number
    }
    expect(olderBody.entries.map(entry => entry.content)).toEqual(['row-0', 'row-1'])
    expect(olderBody.totalEntries).toBeUndefined()
    expect(olderBody.totalTextLines).toBeUndefined()

    const exported = await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs/export?scope=phase&phase=CODING&view=overview`)
    expect(exported.headers.get('content-type')).toContain('text/plain')
    expect((await exported.text()).split('\n').map(line => line.slice(-5))).toEqual(['row-0', 'row-1', 'row-2', 'row-3'])
  })

  it('exports the same complete history whether it fits one page or five', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    for (let index = 0; index < 5; index += 1) {
      appendLogEvent(ticket.id, 'info', 'CODING', `row-${index}`, { timestamp: `2026-01-01T00:00:0${index}.000Z` }, 'system', 'CODING')
    }
    const query = { scope: 'phase', phase: 'CODING', view: 'overview' } as const

    const singlePage = await exportLogEntries(ticket.id, query)
    // One row per page walks four cursors, so an off-by-one or a reversed page order
    // shows up here and nowhere else.
    const manyPages = await exportLogEntries(ticket.id, query, { pageSize: 1 })

    expect(singlePage?.map(entry => entry.content))
      .toEqual(['row-0', 'row-1', 'row-2', 'row-3', 'row-4'])
    expect(manyPages).toEqual(singlePage)

    // A page size below one asks SQLite for nothing, and the walk would end on the first
    // turn — a complete export replaced by an empty one, with nothing to say so.
    await expect(exportLogEntries(ticket.id, query, { pageSize: 0 })).rejects.toThrow(RangeError)
  })

  it('counts logical text lines for the complete filtered result without applying the page cursor', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    appendLogEvent(ticket.id, 'info', 'CODING', 'first\nsecond\nthird', {}, 'system', 'CODING')
    appendLogEvent(ticket.id, 'info', 'CODING', '', {}, 'system', 'CODING')
    appendLogEvent(ticket.id, 'info', 'CODING', '[CMD] $ ignored-overview\nsecond-command-line', {}, 'system', 'CODING')
    appendLogEvent(ticket.id, 'info', 'RUNNING_FINAL_TEST', 'different phase\nline', {}, 'system', 'RUNNING_FINAL_TEST')

    const overviewResponse = await app.request(
      `/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&view=overview&limit=1`,
    )
    const overview = await overviewResponse.json() as {
      olderCursor: string
      totalEntries: number
      totalTextLines: number
    }
    expect(overview.totalEntries).toBe(2)
    expect(overview.totalTextLines).toBe(3)

    const olderResponse = await app.request(
      `/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&view=overview&limit=1&before=${encodeURIComponent(overview.olderCursor)}`,
    )
    expect(await olderResponse.json()).not.toEqual(expect.objectContaining({
      totalEntries: expect.any(Number),
      totalTextLines: expect.any(Number),
    }))

    const commandResponse = await app.request(
      `/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&view=command`,
    )
    expect(await commandResponse.json()).toEqual(expect.objectContaining({
      totalEntries: 1,
      totalTextLines: 2,
    }))
  })

  it('uses the shared classification for command, error, AI, and debug views', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
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
    const { ticket } = await createInitializedTestTicket(repoManager)
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
