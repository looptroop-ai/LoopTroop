import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { appendFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { clearProjectDatabaseCache, getProjectDatabase } from '../../db/project'
import { sqlite } from '../../db/index'
import { appendLogEvent } from '../../log/executionLog'
import { exportLogEntries, queryLogPage } from '../../log/projection'
import { ticketRouter } from '../tickets'
import { health } from '../health'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { getTicketPaths } from '../../storage/tickets'
import { getTicketContext } from '../../storage/ticketQueries'
import type {
  OpenCodeNativeLogEntry,
  OpenCodeNativeLogFile,
  OpenCodeNativeLogReadOptions,
} from '../../opencode/logDiagnostics'

type NativeLogReader = (
  file: OpenCodeNativeLogFile,
  sessionIds: string[],
  options?: OpenCodeNativeLogReadOptions,
) => Promise<OpenCodeNativeLogEntry[]>

const { listOpenCodeNativeLogFilesMock, readOpenCodeNativeLogFileMock } = vi.hoisted(() => ({
  listOpenCodeNativeLogFilesMock: vi.fn(() => [] as OpenCodeNativeLogFile[]),
  readOpenCodeNativeLogFileMock: vi.fn<NativeLogReader>(async () => []),
}))

vi.mock('../../opencode/logDiagnostics', async importOriginal => ({
  ...await importOriginal<typeof import('../../opencode/logDiagnostics')>(),
  listOpenCodeNativeLogFiles: listOpenCodeNativeLogFilesMock,
  readOpenCodeNativeLogFile: readOpenCodeNativeLogFileMock,
}))

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}))

const repoManager = createTestRepoManager('log-projection-')
const app = new Hono()
app.route('/api', ticketRouter)
app.route('/api', health)

beforeEach(() => {
  clearProjectDatabaseCache()
  resetTestDb()
  listOpenCodeNativeLogFilesMock.mockReset()
  listOpenCodeNativeLogFilesMock.mockReturnValue([])
  readOpenCodeNativeLogFileMock.mockReset()
  readOpenCodeNativeLogFileMock.mockResolvedValue([])
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

  it('makes historical DEBUG a four-source ticket-scoped union', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    appendLogEvent(ticket.id, 'info', 'CODING', 'system row', {
      sessionId: 'session-debug', phaseAttempt: 2, timestamp: '2026-01-01T00:00:01.000Z',
    }, 'system', 'CODING')
    appendLogEvent(ticket.id, 'model_output', 'CODING', 'AI row', {
      audience: 'ai', kind: 'text', sessionId: 'session-debug', entryId: 'ai-row',
      phaseAttempt: 2, timestamp: '2026-01-01T00:00:02.000Z',
    }, 'opencode', 'CODING')
    appendLogEvent(ticket.id, 'debug', 'CODING', 'debug row', {
      phaseAttempt: 2, timestamp: '2026-01-01T00:00:03.000Z',
    }, 'debug', 'CODING')
    listOpenCodeNativeLogFilesMock.mockReturnValue([{ path: 'debug.log', mtimeMs: 1, size: 2 }])
    readOpenCodeNativeLogFileMock.mockResolvedValue([
      {
        timestamp: '2026-01-01T00:00:04.000Z', type: 'debug', source: 'debug', audience: 'debug',
        kind: 'session', op: 'append', phase: 'opencode_native', phaseAttempt: 1,
        status: 'opencode_native', message: 'native row', content: 'native row',
        sessionId: 'session-debug', data: {}, nativeIdentity: 'debug.log:1',
      },
      {
        timestamp: '2026-01-01T00:00:05.000Z', type: 'debug', source: 'debug', audience: 'debug',
        kind: 'session', op: 'append', phase: 'opencode_native', phaseAttempt: 1,
        status: 'opencode_native', message: 'other ticket native row', content: 'other ticket native row',
        sessionId: 'other-ticket-session', data: {}, nativeIdentity: 'debug.log:2',
      },
    ])

    const response = await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&phaseAttempt=2&view=debug&limit=2`)
    expect(response.status).toBe(200)
    const body = await response.json() as { entries: Array<{ content: string }>; olderCursor: string | null }
    const pages = [body.entries]
    let before = body.olderCursor
    while (before) {
      const olderResponse = await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&phaseAttempt=2&view=debug&limit=2&before=${encodeURIComponent(before)}`)
      expect(olderResponse.status).toBe(200)
      const olderBody = await olderResponse.json() as { entries: Array<{ content: string }>; olderCursor: string | null }
      pages.push(olderBody.entries)
      before = olderBody.olderCursor
    }
    expect(pages.toReversed().flatMap(page => page.map(entry => entry.content))).toEqual([
      'system row', 'AI row', 'debug row', 'native row',
    ])
    expect(new Set(pages.flatMap(page => page.map(entry => entry.content))).size).toBe(4)
    expect(readOpenCodeNativeLogFileMock).toHaveBeenCalledWith(
      { path: 'debug.log', mtimeMs: 1, size: 2 },
      ['session-debug'],
      expect.objectContaining({ startOffset: 0, startLine: 0 }),
    )
    expect(readOpenCodeNativeLogFileMock).toHaveBeenCalledTimes(1)
  })

  it('uses the native timestamp index for newest and older keyset pages', async () => {
    const { ticket, repoDir } = await createInitializedTestTicket(repoManager)
    appendLogEvent(ticket.id, 'info', 'CODING', 'ticket session', {
      sessionId: 'session-plan', timestamp: '2026-01-01T00:00:01.000Z',
    }, 'system', 'CODING')
    const nativeEntry = (entryId: string, timestamp: string): OpenCodeNativeLogEntry => ({
      timestamp, type: 'debug', source: 'debug', audience: 'debug', kind: 'session', op: 'append',
      phase: 'opencode_native', phaseAttempt: 1, status: 'opencode_native', message: entryId, content: entryId,
      sessionId: 'session-plan', data: {}, nativeIdentity: 'native.log:' + entryId,
    })
    listOpenCodeNativeLogFilesMock.mockReturnValue([{ path: 'native.log', mtimeMs: 1, size: 2 }])
    readOpenCodeNativeLogFileMock.mockResolvedValue([
      nativeEntry('native-new', '2026-01-01T00:00:03.000Z'),
      nativeEntry('native-old', '2026-01-01T00:00:02.000Z'),
    ])

    const first = await queryLogPage(ticket.id, {
      scope: 'phase', phase: 'CODING', view: 'debug', limit: 1,
    })
    expect(first?.olderCursor).toEqual(expect.any(String))
    const cursor = JSON.parse(Buffer.from(first!.olderCursor!, 'base64url').toString('utf8')) as {
      nativeSnapshot: string
      timestamp: string
      mirrorKey: string
    }
    const sqlite = getProjectDatabase(repoDir).sqlite
    const ticketContext = getTicketContext(ticket.id)
    expect(ticketContext?.localTicketId).toEqual(expect.any(Number))
    const snapshotFile = sqlite.prepare(`
      SELECT path, generation, session_ids
      FROM execution_log_native_snapshot_files
      WHERE ticket_id = ? AND snapshot_key = ?
    `).get(ticketContext!.localTicketId, cursor.nativeSnapshot) as {
      path: string
      generation: number
      session_ids: string
    }
    const indexedRows = sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM execution_log_native_index_entries
      WHERE ticket_id = ? AND path = ? AND generation = ?
    `).get(ticketContext!.localTicketId, snapshotFile.path, snapshotFile.generation) as { count: number }
    const snapshotPointers = sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM execution_log_native_snapshot_files
      WHERE ticket_id = ? AND snapshot_key = ?
    `).get(ticketContext!.localTicketId, cursor.nativeSnapshot) as { count: number }
    expect(indexedRows.count).toBe(2)
    expect(snapshotPointers.count).toBe(1)
    const newestPlan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT timestamp, sort_key, model_id, entry_json
      FROM execution_log_native_index_entries
      WHERE ticket_id = ? AND path = ? AND generation = ? AND session_id = ?
      ORDER BY timestamp_rank DESC, timestamp DESC, sort_key DESC
      LIMIT 2
    `).all(ticketContext!.localTicketId, snapshotFile.path, snapshotFile.generation, 'session-plan') as Array<{ detail: string }>
    const olderPlan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT timestamp, sort_key, model_id, entry_json
      FROM execution_log_native_index_entries
      WHERE ticket_id = ? AND path = ? AND generation = ? AND session_id = ?
        AND (timestamp_rank, timestamp, sort_key) < (?, ?, ?)
      ORDER BY timestamp_rank DESC, timestamp DESC, sort_key DESC
      LIMIT 2
    `).all(ticketContext!.localTicketId, snapshotFile.path, snapshotFile.generation, 'session-plan', 0, cursor.timestamp, cursor.mirrorKey) as Array<{ detail: string }>
    expect(newestPlan.map(row => row.detail).join(' ')).toContain('idx_execution_log_native_index_entries_order')
    expect(olderPlan.map(row => row.detail).join(' ')).toContain('idx_execution_log_native_index_entries_order')
    expect((newestPlan.map(row => row.detail).join(' ') + ' ' + olderPlan.map(row => row.detail).join(' ')))
      .not.toContain('USE TEMP B-TREE FOR ORDER BY')
    const actualPlan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT timestamp, sort_key, model_id, entry_json, e.path, e.generation, e.line_number
      FROM execution_log_native_index_entries AS e
        INDEXED BY idx_execution_log_native_index_entries_global
      JOIN execution_log_native_snapshot_files AS sf
        ON sf.ticket_id = e.ticket_id AND sf.snapshot_key = ? AND sf.path = e.path
      WHERE e.ticket_id = ? AND e.session_id = ?
        AND e.generation >= sf.root_generation AND e.generation <= sf.generation
        AND NOT EXISTS (
          SELECT 1 FROM execution_log_native_index_versions AS newer
          WHERE newer.ticket_id = e.ticket_id AND newer.path = e.path
            AND newer.generation > e.generation AND newer.generation <= sf.generation
            AND newer.replace_from_line <= e.line_number
        )
        AND (e.timestamp_rank, e.timestamp, e.sort_key) < (?, ?, ?)
      ORDER BY e.timestamp_rank DESC, e.timestamp DESC, e.sort_key DESC, e.line_number DESC
      LIMIT ?
    `).all(cursor.nativeSnapshot, ticketContext!.localTicketId, 'session-plan', 0, cursor.timestamp, cursor.mirrorKey, 2) as Array<{ detail: string }>
    const actualPlanDetails = actualPlan.map(row => row.detail).join(' ')
    expect(actualPlanDetails).toContain('idx_execution_log_native_index_entries_global')
    expect(actualPlanDetails).toContain('sqlite_autoindex_execution_log_native_index_versions_1')
    expect(actualPlanDetails).not.toContain('USE TEMP B-TREE FOR ORDER BY')
  })

  it('pages persisted debug rows when a ticket has no native sessions', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    appendLogEvent(ticket.id, 'debug', 'CODING', 'persisted debug newest', { timestamp: '2026-01-01T00:00:03.000Z' }, 'debug', 'CODING')
    appendLogEvent(ticket.id, 'debug', 'CODING', 'persisted debug oldest', { timestamp: '2026-01-01T00:00:01.000Z' }, 'debug', 'CODING')
    const first = await queryLogPage(ticket.id, {
      scope: 'phase', phase: 'CODING', view: 'debug', limit: 1,
    })
    expect(first?.entries).toHaveLength(1)
    expect(first?.olderCursor).toEqual(expect.any(String))
    const older = await queryLogPage(ticket.id, {
      scope: 'phase', phase: 'CODING', view: 'debug', limit: 1, before: first!.olderCursor!,
    })
    expect(older?.entries.map(entry => entry.content)).toEqual(['persisted debug oldest'])
  })

  it('reports an expired native cursor instead of returning a partial page', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    appendLogEvent(ticket.id, 'info', 'CODING', 'ticket session', {
      sessionId: 'session-expiry', timestamp: '2026-01-01T00:00:01.000Z',
    }, 'system', 'CODING')
    const nativeEntry = (entryId: string): OpenCodeNativeLogEntry => ({
      timestamp: '2026-01-01T00:00:02.000Z', type: 'debug', source: 'debug', audience: 'debug', kind: 'session', op: 'append',
      phase: 'opencode_native', phaseAttempt: 1, status: 'opencode_native', message: entryId, content: entryId,
      sessionId: 'session-expiry', data: {}, nativeIdentity: 'native.log:' + entryId,
    })
    listOpenCodeNativeLogFilesMock.mockReturnValue([{ path: 'native.log', mtimeMs: 1, size: 2 }])
    readOpenCodeNativeLogFileMock.mockResolvedValue([nativeEntry('rotation-1'), nativeEntry('rotation-2')])
    const first = await app.request('/api/tickets/' + encodeURIComponent(ticket.id) + '/logs?scope=phase&phase=CODING&view=debug&limit=1')
    const firstBody = await first.json() as { olderCursor: string }
    expect(firstBody.olderCursor).toEqual(expect.any(String))

    for (let rotation = 3; rotation <= 7; rotation += 1) {
      listOpenCodeNativeLogFilesMock.mockReturnValue([{ path: 'native.log', mtimeMs: rotation, size: rotation + 1 }])
      readOpenCodeNativeLogFileMock.mockResolvedValue([nativeEntry('rotation-' + rotation)])
      const response = await app.request('/api/tickets/' + encodeURIComponent(ticket.id) + '/logs?scope=phase&phase=CODING&view=debug&limit=1')
      expect(response.status).toBe(200)
    }

    const expired = await app.request(
      '/api/tickets/' + encodeURIComponent(ticket.id) + '/logs?scope=phase&phase=CODING&view=debug&limit=1&before=' + encodeURIComponent(firstBody.olderCursor),
    )
    expect(expired.status).toBe(409)
    expect(await expired.json()).toMatchObject({ code: 'LOG_CURSOR_EXPIRED' })
  })

  it('does not cache an empty complete history when a native candidate read fails', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    appendLogEvent(ticket.id, 'info', 'CODING', 'ticket session', {
      sessionId: 'session-read-error', timestamp: '2026-01-01T00:00:01.000Z',
    }, 'system', 'CODING')
    listOpenCodeNativeLogFilesMock.mockReturnValue([{ path: 'unreadable.log', mtimeMs: 1, size: 2 }])
    readOpenCodeNativeLogFileMock.mockRejectedValue(new Error('EACCES'))

    const response = await app.request('/api/tickets/' + encodeURIComponent(ticket.id) + '/logs?scope=phase&phase=CODING&view=debug')
    expect(response.status).toBe(500)
  })

  it('indexes an append from the saved byte offset and snapshots one generation pointer', async () => {
    const { ticket, repoDir } = await createInitializedTestTicket(repoManager)
    appendLogEvent(ticket.id, 'info', 'CODING', 'ticket session', {
      sessionId: 'session-append', timestamp: '2026-01-01T00:00:01.000Z',
    }, 'system', 'CODING')
    let fileSize = 100
    const nativeEntry = (entryId: string, timestamp: string): OpenCodeNativeLogEntry => ({
      timestamp, type: 'debug', source: 'debug', audience: 'debug', kind: 'session', op: 'append',
      phase: 'opencode_native', phaseAttempt: 1, status: 'opencode_native', message: entryId, content: entryId,
      sessionId: 'session-append', data: {}, nativeIdentity: `native.log:${entryId}`,
    })
    listOpenCodeNativeLogFilesMock.mockImplementation(() => [{
      path: 'native.log', mtimeMs: fileSize, size: fileSize, fileIdentity: 'dev:1',
    }])
    readOpenCodeNativeLogFileMock.mockImplementation(async (_file, _sessions, options) => {
      const appending = fileSize === 130
      const records = appending
        ? [nativeEntry('third', '2026-01-01T00:00:04.000Z')]
        : [nativeEntry('first', '2026-01-01T00:00:02.000Z'), nativeEntry('second', '2026-01-01T00:00:03.000Z')]
      const startOffset = options?.startOffset ?? 0
      const startLine = options?.startLine ?? 0
      records.forEach((record, index) => options?.onEntry?.(record, {
        lineNumber: startLine + index,
        byteOffset: startOffset + index * 15,
        byteLength: 15,
        complete: true,
      }))
      if (options?.stats) {
        options.stats.linesRead = records.length
        options.stats.indexedOffset = fileSize
        options.stats.indexedLines = startLine + records.length
        options.stats.tailOffset = fileSize
        options.stats.endedWithNewline = true
        options.stats.entriesRead = records.length
      }
      return []
    })

    const first = await queryLogPage(ticket.id, {
      scope: 'phase', phase: 'CODING', view: 'debug', limit: 20,
    })
    expect(first?.entries.map(entry => entry.content)).toEqual(['ticket session', 'first', 'second'])
    fileSize = 130
    const second = await queryLogPage(ticket.id, {
      scope: 'phase', phase: 'CODING', view: 'debug', limit: 20,
    })
    expect(second?.entries.map(entry => entry.content)).toEqual(['ticket session', 'first', 'second', 'third'])
    expect(readOpenCodeNativeLogFileMock.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      startOffset: 100,
      startLine: 2,
    }))

    const sqlite = getProjectDatabase(repoDir).sqlite
    const ticketContext = getTicketContext(ticket.id)
    const generations = sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM execution_log_native_index_versions
      WHERE ticket_id = ? AND path = 'native.log'
    `).get(ticketContext!.localTicketId) as { count: number }
    const indexed = sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM execution_log_native_index_entries
      WHERE ticket_id = ? AND path = 'native.log'
    `).get(ticketContext!.localTicketId) as { count: number }
    const snapshotPointers = sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM execution_log_native_snapshot_files
      WHERE ticket_id = ?
    `).get(ticketContext!.localTicketId) as { count: number }
    expect(generations.count).toBe(2)
    expect(indexed.count).toBe(3)
    expect(snapshotPointers.count).toBe(2)
    const exported = await exportLogEntries(ticket.id, {
      scope: 'phase', phase: 'CODING', view: 'debug',
    }, { pageSize: 1 })
    expect(exported?.map(entry => entry.content)).toEqual(['ticket session', 'first', 'second', 'third'])
  })

  it('bounds a missing-session prefix before appending the suffix for every session', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    appendLogEvent(ticket.id, 'info', 'CODING', 'session A', {
      sessionId: 'session-a', timestamp: '2026-01-01T00:00:01.000Z',
    }, 'system', 'CODING')
    let fileSize = 200
    const records = [
      ['session-a', 'A old'],
      ['session-b', 'B old'],
      ['session-b', 'B new'],
      ['session-a', 'A new'],
    ] as const
    const nativeEntry = (sessionId: string, content: string, index: number): OpenCodeNativeLogEntry => ({
      timestamp: `2026-01-01T00:00:0${index}.000Z`, type: 'debug', source: 'debug', audience: 'debug',
      kind: 'session', op: 'append', phase: 'opencode_native', phaseAttempt: 1, status: 'opencode_native',
      message: content, content, sessionId, data: {}, nativeIdentity: `native.log:${index}`,
    })
    listOpenCodeNativeLogFilesMock.mockImplementation(() => [{
      path: 'native.log', mtimeMs: fileSize, size: fileSize, fileIdentity: 'dev:missing-session',
    }])
    readOpenCodeNativeLogFileMock.mockImplementation(async (_file, sessions, options) => {
      const start = (options?.startOffset ?? 0) >= 200 ? 2 : 0
      const end = fileSize === 200 ? 2 : records.length
      for (let index = start; index < end; index += 1) {
        const [sessionId, content] = records[index]!
        if (!sessions.includes(sessionId)) continue
        options?.onEntry?.(nativeEntry(sessionId, content, index), {
          lineNumber: index,
          byteOffset: index * 100,
          byteLength: 100,
          complete: true,
        })
      }
      if (options?.stats) {
        options.stats.indexedOffset = fileSize
        options.stats.indexedLines = fileSize === 200 ? 2 : 4
        options.stats.tailOffset = fileSize
      }
      return []
    })

    const first = await queryLogPage(ticket.id, { scope: 'phase', phase: 'CODING', view: 'debug', limit: 20 })
    expect(first?.entries.map(entry => entry.content)).toContain('A old')
    appendLogEvent(ticket.id, 'info', 'CODING', 'session B', {
      sessionId: 'session-b', timestamp: '2026-01-01T00:00:02.000Z',
    }, 'system', 'CODING')
    fileSize = 400
    const second = await queryLogPage(ticket.id, { scope: 'phase', phase: 'CODING', view: 'debug', limit: 20 })
    const nativeContents = second?.entries
      .filter(entry => entry.source === 'debug' && entry.phase === 'opencode_native')
      .map(entry => entry.content)
    expect(nativeContents).toEqual(['A old', 'B old', 'B new', 'A new'])
    expect(nativeContents?.filter(content => content === 'B new')).toHaveLength(1)
  })

  it('replaces an existing unterminated tail while adding a newly requested session', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    appendLogEvent(ticket.id, 'info', 'CODING', 'session A', {
      sessionId: 'session-tail-a', timestamp: '2026-01-01T00:00:01.000Z',
    }, 'system', 'CODING')
    let appended = false
    const nativeEntry = (sessionId: string, content: string, index: number): OpenCodeNativeLogEntry => ({
      timestamp: `2026-01-01T00:00:0${index}.000Z`, type: 'debug', source: 'debug', audience: 'debug',
      kind: 'session', op: 'append', phase: 'opencode_native', phaseAttempt: 1, status: 'opencode_native',
      message: content, content, sessionId, data: {}, nativeIdentity: `tail.log:${index}`,
    })
    listOpenCodeNativeLogFilesMock.mockImplementation(() => [{
      path: 'tail.log', mtimeMs: appended ? 2 : 1, size: appended ? 200 : 100, fileIdentity: 'dev:tail',
    }])
    readOpenCodeNativeLogFileMock.mockImplementation(async (_file, sessions, options) => {
      const records: Array<[string, string]> = appended
        ? [['session-tail-a', 'A tail'], ['session-tail-b', 'B new']]
        : [['session-tail-a', 'A tail']]
      for (const [index, [sessionId, content]] of records.entries()) {
        if (!sessions.includes(sessionId)) continue
        options?.onEntry?.(nativeEntry(sessionId, content, index), {
          lineNumber: index, byteOffset: index * 100, byteLength: 100, complete: true,
        })
      }
      if (options?.stats) {
        options.stats.indexedOffset = appended ? 0 : 0
        options.stats.indexedLines = 0
        options.stats.tailOffset = 0
      }
      return []
    })

    const first = await queryLogPage(ticket.id, { scope: 'phase', phase: 'CODING', view: 'debug', limit: 20 })
    expect(first?.entries.map(entry => entry.content)).toContain('A tail')
    appended = true
    appendLogEvent(ticket.id, 'info', 'CODING', 'session B', {
      sessionId: 'session-tail-b', timestamp: '2026-01-01T00:00:02.000Z',
    }, 'system', 'CODING')
    const second = await queryLogPage(ticket.id, { scope: 'phase', phase: 'CODING', view: 'debug', limit: 20 })
    const nativeContents = second?.entries
      .filter(entry => entry.source === 'debug' && entry.phase === 'opencode_native')
      .map(entry => entry.content)
    expect(nativeContents).toEqual(['A tail', 'B new'])
  })

  it('retains the current manifest when snapshot timestamps tie or roll back', async () => {
    const { ticket, repoDir } = await createInitializedTestTicket(repoManager)
    appendLogEvent(ticket.id, 'info', 'CODING', 'session for rotation', {
      sessionId: 'session-clock', timestamp: '2026-01-01T00:00:01.000Z',
    }, 'system', 'CODING')
    let rotation = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => rotation < 6 ? 1000 : 500)
    listOpenCodeNativeLogFilesMock.mockImplementation(() => [{
      path: 'clock.log', mtimeMs: rotation, size: rotation + 100, fileIdentity: `dev:clock-${rotation}`,
    }])
    readOpenCodeNativeLogFileMock.mockImplementation(async (_file, _sessions, options) => {
      const content = `rotation-${rotation}`
      options?.onEntry?.({
        timestamp: '2026-01-01T00:00:02.000Z', type: 'debug', source: 'debug', audience: 'debug',
        kind: 'session', op: 'append', phase: 'opencode_native', phaseAttempt: 1, status: 'opencode_native',
        message: content, content, sessionId: 'session-clock', data: {}, nativeIdentity: `clock.log:${rotation}`,
      }, { lineNumber: 0, byteOffset: 0, byteLength: 100, complete: true })
      if (options?.stats) {
        options.stats.indexedOffset = rotation + 100
        options.stats.indexedLines = 1
        options.stats.tailOffset = rotation + 100
      }
      return []
    })
    try {
      let lastPage
      for (rotation = 0; rotation < 12; rotation += 1) {
        lastPage = await queryLogPage(ticket.id, { scope: 'phase', phase: 'CODING', view: 'debug', limit: 1 })
        expect(lastPage?.entries).toEqual(expect.any(Array))
      }
      const cursor = JSON.parse(Buffer.from(lastPage!.olderCursor!, 'base64url').toString('utf8')) as { nativeSnapshot: string }
      const db = getProjectDatabase(repoDir).sqlite
      const context = getTicketContext(ticket.id)
      const current = db.prepare(`
        SELECT generation FROM execution_log_native_index_files
        WHERE ticket_id = ? AND path = 'clock.log'
      `).get(context!.localTicketId) as { generation: number }
      const currentPointer = db.prepare(`
        SELECT generation FROM execution_log_native_snapshot_files
        WHERE ticket_id = ? AND snapshot_key = ? AND path = 'clock.log'
      `).get(context!.localTicketId, cursor.nativeSnapshot) as { generation: number }
      expect(currentPointer.generation).toBe(current.generation)
      const snapshots = db.prepare(`
        SELECT COUNT(*) AS count FROM execution_log_native_snapshots WHERE ticket_id = ?
      `).get(context!.localTicketId) as { count: number }
      expect(snapshots.count).toBe(4)
    } finally {
      clock.mockRestore()
    }
  })

  it('keeps unrelated native rotation out of the ticket snapshot and ingests it separately', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    appendLogEvent(ticket.id, 'info', 'CODING', 'ticket session', {
      sessionId: 'session-incremental', timestamp: '2026-01-01T00:00:01.000Z',
    }, 'system', 'CODING')
    const nativeEntry = (): OpenCodeNativeLogEntry => ({
      timestamp: '2026-01-01T00:00:02.000Z', type: 'debug', source: 'debug', audience: 'debug', kind: 'session', op: 'append',
      phase: 'opencode_native', phaseAttempt: 1, status: 'opencode_native', message: 'ticket native', content: 'ticket native',
      sessionId: 'session-incremental', data: {}, nativeIdentity: 'relevant.log:1',
    })
    let unrelatedMtime = 1
    listOpenCodeNativeLogFilesMock.mockImplementation(() => [
      { path: 'relevant.log', mtimeMs: 1, size: 2 },
      { path: 'unrelated.log', mtimeMs: unrelatedMtime, size: 2 },
    ])
    readOpenCodeNativeLogFileMock.mockImplementation(async file => file.path === 'relevant.log' ? [nativeEntry()] : [])

    const first = await queryLogPage(ticket.id, {
      scope: 'phase', phase: 'CODING', view: 'debug', limit: 20,
    })
    expect(first?.entries.map(entry => entry.content)).toContain('ticket native')
    readOpenCodeNativeLogFileMock.mockClear()
    unrelatedMtime = 2
    const second = await queryLogPage(ticket.id, {
      scope: 'phase', phase: 'CODING', view: 'debug', limit: 20,
    })
    expect(second?.entries.map(entry => entry.content)).toContain('ticket native')
    expect(readOpenCodeNativeLogFileMock).toHaveBeenCalledTimes(1)
    expect(readOpenCodeNativeLogFileMock).toHaveBeenCalledWith(
      { path: 'unrelated.log', mtimeMs: 2, size: 2 },
      ['session-incremental'],
      expect.objectContaining({ startOffset: 0, startLine: 0 }),
    )
  })

  it('serializes native ingestion across concurrent phase session scopes', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    appendLogEvent(ticket.id, 'info', 'CODING', 'attempt one', {
      sessionId: 'session-one', phaseAttempt: 1, timestamp: '2026-01-01T00:00:01.000Z',
    }, 'system', 'CODING')
    appendLogEvent(ticket.id, 'info', 'CODING', 'attempt two', {
      sessionId: 'session-two', phaseAttempt: 2, timestamp: '2026-01-01T00:00:02.000Z',
    }, 'system', 'CODING')
    const nativeEntry = (sessionId: string): OpenCodeNativeLogEntry => ({
      timestamp: '2026-01-01T00:00:03.000Z', type: 'debug', source: 'debug', audience: 'debug',
      kind: 'session', op: 'append', phase: 'opencode_native', phaseAttempt: 1,
      status: 'opencode_native', message: sessionId, content: sessionId, sessionId,
      data: {}, nativeIdentity: `native.log:${sessionId}`,
    })
    listOpenCodeNativeLogFilesMock.mockReturnValue([{ path: 'native.log', mtimeMs: 1, size: 2 }])
    let readCount = 0
    let releaseFirst!: () => void
    let firstReadStarted!: () => void
    const firstRead = new Promise<void>(resolve => { firstReadStarted = resolve })
    const firstReadRelease = new Promise<void>(resolve => { releaseFirst = resolve })
    readOpenCodeNativeLogFileMock.mockImplementation(async (_file, sessions) => {
      readCount += 1
      if (readCount === 1) {
        firstReadStarted()
        await firstReadRelease
      }
      return sessions.map(nativeEntry)
    })

    const firstRequest = queryLogPage(ticket.id, {
      scope: 'phase', phase: 'CODING', phaseAttempt: 1, view: 'debug', limit: 20,
    })
    await firstRead
    const secondRequest = queryLogPage(ticket.id, {
      scope: 'phase', phase: 'CODING', phaseAttempt: 2, view: 'debug', limit: 20,
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(readCount).toBe(1)
    releaseFirst()

    const [first, second] = await Promise.all([firstRequest, secondRequest])
    expect(first?.entries.map(entry => entry.content)).toContain('session-one')
    expect(second?.entries.map(entry => entry.content)).toContain('session-two')
    expect(readOpenCodeNativeLogFileMock).toHaveBeenCalledTimes(2)
    expect(readOpenCodeNativeLogFileMock.mock.calls[1]?.[1]).toEqual(['session-two'])
  })

  it('keeps a native cursor on its indexed snapshot when files rotate between pages', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    appendLogEvent(ticket.id, 'info', 'CODING', 'ticket session', {
      sessionId: 'session-stable', timestamp: '2026-01-01T00:00:01.000Z',
    }, 'system', 'CODING')
    const nativeEntry = (entryId: string, timestamp: string): OpenCodeNativeLogEntry => ({
      timestamp, type: 'debug', source: 'debug', audience: 'debug', kind: 'session', op: 'append',
      phase: 'opencode_native', phaseAttempt: 1, status: 'opencode_native', message: entryId, content: entryId,
      sessionId: 'session-stable', data: {}, nativeIdentity: `native.log:${entryId}`,
    })
    listOpenCodeNativeLogFilesMock.mockReturnValue([{ path: 'native.log', mtimeMs: 1, size: 2 }])
    readOpenCodeNativeLogFileMock.mockResolvedValue([
      nativeEntry('native-new', '2026-01-01T00:00:03.000Z'),
      nativeEntry('native-old', '2026-01-01T00:00:02.000Z'),
    ])

    const firstResponse = await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&view=debug&limit=1`)
    const first = await firstResponse.json() as { entries: Array<{ content: string }>; olderCursor: string | null }
    expect(first.entries.map(entry => entry.content)).toEqual(['native-new'])
    expect(first.olderCursor).toEqual(expect.any(String))

    listOpenCodeNativeLogFilesMock.mockReturnValue([{ path: 'native.log', mtimeMs: 2, size: 3 }])
    readOpenCodeNativeLogFileMock.mockResolvedValue([nativeEntry('rotated-new', '2026-01-01T00:00:04.000Z')])
    const olderResponse = await app.request(
      `/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&view=debug&limit=1&before=${encodeURIComponent(first.olderCursor!)}`,
    )
    const older = await olderResponse.json() as { entries: Array<{ content: string }> }
    expect(older.entries.map(entry => entry.content)).toEqual(['native-old'])
    expect(readOpenCodeNativeLogFileMock).toHaveBeenCalledTimes(1)
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

  it('restores model milestones and source-attributed rows once across pages and exports', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const scope = { audience: 'all', kind: 'milestone', phaseAttempt: 2, beadId: 'bead-1' }
    appendLogEvent(ticket.id, 'info', 'CODING', 'model milestone', { ...scope, modelId: 'test/model' }, 'system', 'CODING')
    appendLogEvent(ticket.id, 'model_output', 'CODING', 'model output', { ...scope, audience: 'ai', kind: 'text', modelId: 'test/model' }, 'opencode', 'CODING')
    appendLogEvent(ticket.id, 'info', 'CODING', 'source milestone', scope, 'model:test/model', 'CODING')
    appendLogEvent(ticket.id, 'info', 'CODING', 'session milestone', { ...scope, sessionId: 'session-1' }, 'system', 'CODING')
    appendLogEvent(ticket.id, 'info', 'CODING', 'opencode milestone', scope, 'opencode', 'CODING')
    appendLogEvent(ticket.id, 'info', 'CODING', 'unrelated system row', scope, 'system', 'CODING')
    appendLogEvent(ticket.id, 'debug', 'CODING', 'model debug row', { ...scope, modelId: 'test/model' }, 'debug', 'CODING')
    appendLogEvent(ticket.id, 'info', 'CODING', 'other model', { ...scope, modelId: 'test/other' }, 'model:test/model', 'CODING')
    appendLogEvent(ticket.id, 'info', 'CODING', 'other attempt', { ...scope, phaseAttempt: 1, modelId: 'test/model' }, 'system', 'CODING')
    appendLogEvent(ticket.id, 'info', 'CODING', 'other bead', { ...scope, beadId: 'bead-2', modelId: 'test/model' }, 'system', 'CODING')
    appendLogEvent(ticket.id, 'info', 'RUNNING_FINAL_TEST', 'other phase', { ...scope, modelId: 'test/model' }, 'system', 'RUNNING_FINAL_TEST')

    const url = `/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&phaseAttempt=2&beadId=bead-1&view=ai&modelId=test%2Fmodel&limit=2`
    const response = await app.request(url)
    expect(response.status).toBe(200)
    const first = await response.json() as { entries: Array<{ content: string }>; olderCursor: string; totalEntries: number; totalTextLines: number }
    expect(first.entries.map(entry => entry.content)).toEqual(['model output', 'source milestone'])
    expect(first.totalEntries).toBe(3)
    expect(first.totalTextLines).toBe(3)
    const older = await app.request(`${url}&before=${encodeURIComponent(first.olderCursor)}`)
    expect(await older.json()).toMatchObject({
      entries: [{ content: 'model milestone' }],
      hasOlder: false,
    })

    const query = { scope: 'phase', phase: 'CODING', phaseAttempt: 2, beadId: 'bead-1', view: 'ai' } as const
    const modelExport = await exportLogEntries(ticket.id, { ...query, modelId: 'test/model' }, { pageSize: 1 })
    expect(modelExport?.map(entry => entry.content)).toEqual(['model milestone', 'model output', 'source milestone'])
    const aiExport = await exportLogEntries(ticket.id, query, { pageSize: 2 })
    expect(aiExport?.map(entry => entry.content)).toEqual([
      'model milestone', 'model output', 'source milestone', 'session milestone', 'opencode milestone', 'other model',
    ])
  })

  it('lists all scoped models independently of the selected view, model, and newest page', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const { ticket: otherTicket } = await createInitializedTestTicket(repoManager)
    const scope = { audience: 'all', kind: 'milestone', phaseAttempt: 2, beadId: 'bead-1' }
    appendLogEvent(ticket.id, 'info', 'CODING', 'older explicit model', { ...scope, modelId: 'test/a' }, 'model:test/ignored-source', 'CODING')
    appendLogEvent(ticket.id, 'info', 'CODING', 'older source model', { ...scope, modelId: '' }, 'model:test/b', 'CODING')
    appendLogEvent(ticket.id, 'info', 'CODING', 'empty source model', scope, 'model:', 'CODING')
    appendLogEvent(ticket.id, 'info', 'CODING', 'other attempt', { ...scope, phaseAttempt: 1, modelId: 'test/attempt' }, 'system', 'CODING')
    appendLogEvent(ticket.id, 'info', 'CODING', 'other bead', { ...scope, beadId: 'bead-2', modelId: 'test/bead' }, 'system', 'CODING')
    appendLogEvent(ticket.id, 'info', 'RUNNING_FINAL_TEST', 'other phase', { ...scope, modelId: 'test/phase' }, 'system', 'RUNNING_FINAL_TEST')
    appendLogEvent(otherTicket.id, 'info', 'CODING', 'other ticket', { ...scope, modelId: 'test/ticket' }, 'system', 'CODING')
    appendLogEvent(ticket.id, 'debug', 'CODING', 'debug model', { ...scope, modelId: 'test/debug' }, 'debug', 'CODING')
    appendLogEvent(ticket.id, 'info', 'CODING', 'newest model', { ...scope, modelId: 'test/z' }, 'system', 'CODING')

    const url = `/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=phase&phase=CODING&phaseAttempt=2&beadId=bead-1&limit=1`
    const first = await (await app.request(`${url}&view=ai`)).json() as {
      entries: Array<{ content: string }>; modelIds: string[]; olderCursor: string
    }
    expect(first.entries.map(entry => entry.content)).toEqual(['newest model'])
    expect(first.modelIds).toEqual(['test/a', 'test/b', 'test/z'])
    for (const view of ['overview', 'system', 'command', 'ai', 'error', 'debug']) {
      const response = await app.request(`${url}&view=${view}&modelId=test%2Fz`)
      expect(await response.json()).toMatchObject({ modelIds: first.modelIds })
    }
    const older = await app.request(`${url}&view=ai&before=${encodeURIComponent(first.olderCursor)}`)
    expect(await older.json()).not.toHaveProperty('modelIds')
    const withoutTotals = await queryLogPage(ticket.id, {
      scope: 'phase', phase: 'CODING', view: 'ai', limit: 1, includeTotals: false,
    })
    expect(withoutTotals).not.toHaveProperty('modelIds')

    const lifecycle = await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?scope=lifecycle&view=ai&limit=1`)
    expect(await lifecycle.json()).toMatchObject({
      modelIds: ['test/a', 'test/attempt', 'test/b', 'test/bead', 'test/phase', 'test/z'],
    })
  })

  it('recovers AI-only writes and newer finalizations without losing repeated anonymous appends', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const paths = getTicketPaths(ticket.id)!
    const base = { phase: 'CODING', phaseAttempt: 1, type: 'model_output', audience: 'ai', source: 'model:test/model' }
    const row = (second: number, content: string, fields = {}) => ({
      ...base, timestamp: `2026-01-01T00:00:0${second}.000Z`, content, ...fields,
    })
    const prompt = row(0, 'prompt', { fingerprint: 'prompt-1' })
    const old = row(1, 'old response', { entryId: 'response-1', op: 'finalize' })
    const repeated = row(2, 'repeated\nline')
    const survivor = row(3, 'surviving AI write', { source: 'model:test/survivor', timestamp: '2026-01-01T02:00:03.000+02:00' })
    const tiedMilestone = row(2, 'tied system milestone', { type: 'info', audience: 'all', source: 'system', modelId: 'test/model', timestamp: '2026-01-01T00:00:02.500Z' })
    const milestone = row(4, 'system milestone', { type: 'info', audience: 'all', source: 'system', modelId: 'test/model' })
    appendFileSync(paths.executionLogPath, [prompt, old, repeated, tiedMilestone, milestone].map(entry => JSON.stringify(entry)).join('\n') + '\n')
    appendFileSync(paths.aiLogPath, [prompt, old, repeated, repeated, survivor, row(3, 'new response', { entryId: 'response-1', op: 'finalize' })]
      .map(entry => JSON.stringify(entry)).join('\n') + '\n')

    const query = { scope: 'phase', phase: 'CODING', phaseAttempt: 1, view: 'ai' } as const
    const first = await queryLogPage(ticket.id, { ...query, limit: 1 })
    expect(first).toMatchObject({
      entries: [{ content: 'system milestone' }], totalEntries: 7, totalTextLines: 9,
      modelIds: ['test/model', 'test/survivor'], hasOlder: true,
    })
    const complete = await exportLogEntries(ticket.id, query, { pageSize: 1 })
    expect(complete?.map(entry => entry.content)).toEqual([
      'prompt', 'new response', 'repeated\nline', 'repeated\nline', 'tied system milestone', 'surviving AI write', 'system milestone',
    ])
    expect(complete?.find(entry => entry.content === 'surviving AI write')).not.toHaveProperty('modelId')
    const model = await queryLogPage(ticket.id, { ...query, modelId: 'test/survivor', limit: 1 })
    expect(model).toMatchObject({ entries: [{ content: 'surviving AI write' }], totalEntries: 1 })

    appendFileSync(paths.executionLogPath, JSON.stringify(row(5, 'newest normal response', { entryId: 'response-1', op: 'finalize' })) + '\n')
    appendFileSync(paths.executionLogPath, JSON.stringify(row(6, 'second attempt response', { entryId: 'response-1', op: 'finalize', phaseAttempt: 2 })) + '\n')
    const updated = await exportLogEntries(ticket.id, query, { pageSize: 1 })
    expect(updated?.map(entry => entry.content)).toEqual([
      'prompt', 'newest normal response', 'repeated\nline', 'repeated\nline', 'tied system milestone', 'surviving AI write', 'system milestone',
    ])
    expect(await queryLogPage(ticket.id, { ...query, phaseAttempt: 2, limit: 1 })).toMatchObject({
      entries: [{ content: 'second attempt response' }], totalEntries: 1,
    })
  })

  it('keeps bare model output in AI and ALL without exposing detail or debug rows', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const base = { phase: 'CODING', timestamp: '2026-01-01T00:00:00.000Z' }
    const rows = [
      { ...base, type: 'model_output', content: '[DEBUG] quoted by a model' },
      { ...base, type: 'info', source: 'system', modelId: 'test/model', content: 'Milestone mentions [DEBUG]' },
      { ...base, type: 'debug', source: 'model:test/debug', content: 'Private trace' },
    ]
    appendFileSync(getTicketPaths(ticket.id)!.executionLogPath, rows.map(entry => JSON.stringify(entry)).join('\n') + '\n')
    const page = await queryLogPage(ticket.id, { scope: 'phase', phase: 'CODING', view: 'ai', limit: 20 })
    expect(page).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ content: '[DEBUG] quoted by a model' }),
        expect.objectContaining({ content: 'Milestone mentions [DEBUG]' }),
      ]),
      totalEntries: 2, modelIds: ['test/model'],
    })

    appendFileSync(getTicketPaths(ticket.id)!.executionLogPath, JSON.stringify({
      ...base, type: 'model_output', audience: 'ai', kind: 'tool', content: 'Newer tool detail',
    }) + '\n')
    const overviewQuery = { scope: 'phase', phase: 'CODING', view: 'overview', limit: 1 } as const
    const overview = await queryLogPage(ticket.id, overviewQuery)
    expect(overview).toMatchObject({
      entries: [{ content: 'Milestone mentions [DEBUG]', audience: 'all', kind: 'milestone' }],
      totalEntries: 2, totalTextLines: 2, hasOlder: true,
    })
    expect(await queryLogPage(ticket.id, { ...overviewQuery, before: overview!.olderCursor! })).toMatchObject({
      entries: [{ content: '[DEBUG] quoted by a model', audience: 'ai', kind: 'text' }], hasOlder: false,
    })
    const exported = await exportLogEntries(ticket.id, overviewQuery, { pageSize: 1 })
    expect(exported?.map(entry => entry.content)).toEqual(['[DEBUG] quoted by a model', 'Milestone mentions [DEBUG]'])
    expect(await queryLogPage(ticket.id, { ...overviewQuery, view: 'system' })).toMatchObject({
      entries: [{ content: 'Milestone mentions [DEBUG]' }], totalEntries: 1,
    })
  })

  it('keeps an AI cursor stable when finalization switches the winning channel between pages', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const paths = getTicketPaths(ticket.id)!
    const base = { phase: 'CODING', type: 'model_output', audience: 'ai', op: 'finalize', modelId: 'test/model', timestamp: '2026-01-01T00:00:01.000Z' }
    appendFileSync(paths.executionLogPath, [
      { ...base, entryId: 'a', content: 'older tied row' },
      { ...base, entryId: 'z', content: 'initial response' },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
    const query = { scope: 'phase', phase: 'CODING', view: 'ai', limit: 1 } as const
    const first = await queryLogPage(ticket.id, query)
    expect(first).toMatchObject({ entries: [{ content: 'initial response' }], totalEntries: 2 })
    const final = { ...base, entryId: 'z', content: 'final response', timestamp: '2026-01-01T00:00:05.000Z' }
    appendFileSync(paths.aiLogPath, JSON.stringify(final) + '\n')
    const older = await queryLogPage(ticket.id, { ...query, before: first!.olderCursor! })
    expect(older).toMatchObject({ entries: [{ content: 'older tied row' }], hasOlder: false })
    expect(await queryLogPage(ticket.id, query)).toMatchObject({
      entries: [{ content: 'final response', timestamp: base.timestamp }], totalEntries: 2,
    })

    // Export catches up between pages too: switch back to a newer normal-only
    // finalization after its first page, without revisiting that logical row.
    const realStat = fsPromises.stat
    let catchUps = 0
    const statSpy = vi.spyOn(fsPromises, 'stat').mockImplementation((path, options) => {
      if (path === paths.executionLogPath && ++catchUps === 2) {
        appendFileSync(paths.executionLogPath, JSON.stringify({ ...final, content: 'later response', timestamp: '2026-01-01T00:00:06.000Z' }) + '\n')
      }
      return realStat(path, options)
    })
    try {
      const exported = await exportLogEntries(ticket.id, query, { pageSize: 1 })
      expect(exported?.map(entry => entry.content)).toEqual(['older tied row', 'final response'])
      expect(catchUps).toBe(2)
    } finally {
      statSpy.mockRestore()
    }
  })

  it('exhausts AI pages across undated and equal-timestamp boundaries', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const paths = getTicketPaths(ticket.id)!
    const rows = [
      { entryId: 'dated-a', timestamp: '2026-01-01T00:00:01.000Z', content: 'dated a' },
      { entryId: 'undated-a', timestamp: 'not-a-date', content: 'undated a' },
      { entryId: 'undated-b', timestamp: 'still-not-a-date', content: 'undated b' },
      { entryId: 'dated-b', timestamp: '2026-01-01T00:00:01.000Z', content: 'dated b' },
    ].map(row => ({
      type: 'model_output', phase: 'CODING', phaseAttempt: 1, source: 'opencode',
      audience: 'ai', kind: 'text', op: 'append', fingerprint: row.entryId, ...row,
    }))
    appendFileSync(paths.aiLogPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')

    const query = { scope: 'phase', phase: 'CODING', view: 'ai', limit: 1 } as const
    const ids: string[] = []
    let before: string | undefined
    for (;;) {
      const page = await queryLogPage(ticket.id, { ...query, ...(before ? { before } : {}) })
      expect(page).not.toBeNull()
      ids.push(...page!.entries.map(entry => String(entry.entryId)))
      if (!page!.hasOlder || !page!.olderCursor) break
      before = page!.olderCursor
    }

    expect(ids).toHaveLength(rows.length)
    expect(new Set(ids).size).toBe(rows.length)
    // The request walk is newest-to-oldest; the canonical export/client fold is
    // the reverse: dated rows first, undated rows last, with mirror identity ties.
    expect(ids).toEqual(['undated-b', 'undated-a', 'dated-b', 'dated-a'])
  })

  it('rejects cursor fields with array values before binding them to SQLite', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const valid = { ordinal: 1, timestamp: '', mirrorKey: 'entry:a', mirrorOccurrence: 0 }
    for (const cursor of [
      { ordinal: 1, timestamp: '', channel: ['ai'] },
      ...Object.keys(valid).map(key => ({ ...valid, [key]: ['invalid'] })),
    ]) {
      const before = Buffer.from(JSON.stringify(cursor)).toString('base64url')
      const response = await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?view=ai&before=${before}`)
      expect(response.status).toBe(400)
    }
  })
})
