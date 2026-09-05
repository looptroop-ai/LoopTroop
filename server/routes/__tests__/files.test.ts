import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Hono } from 'hono'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import { createTicket, getTicketPaths } from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { recoverTicketRuntimeArtifacts } from '../../startup'
import { cleanupTicketResources } from '../../phases/cleanup/cleaner'
const { readOpenCodeNativeLogsMock } = vi.hoisted(() => ({ readOpenCodeNativeLogsMock: vi.fn(() => []) }))

// The native entries come from OpenCode's own log directory, which a fixture
// repository has no way to populate; what matters here is what the route does
// with them once it has them.
vi.mock('../../opencode/logDiagnostics', () => ({
  readOpenCodeNativeLogs: readOpenCodeNativeLogsMock,
}))

import { filesRouter } from '../files'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-files-route-',
  files: {
    'README.md': '# LoopTroop Files Route Test\n',
  },
})

function writeJsonl(filePath: string, entries: Record<string, unknown>[]) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
}

function createProjectTicket() {
  const repoDir = repoManager.createRepo()
  const project = attachProject({
    folderPath: repoDir,
    name: 'Files Route',
    shortname: 'FILE',
  })
  const ticket = createTicket({
    projectId: project.id,
    title: 'Read logs',
    description: 'Regression coverage for log file channel reads.',
  })
  const paths = getTicketPaths(ticket.id)
  if (!paths) throw new Error('Expected ticket paths')
  return { repoDir, project, ticket, paths }
}

beforeEach(() => {
  readOpenCodeNativeLogsMock.mockReset()
  readOpenCodeNativeLogsMock.mockReturnValue([])
  clearProjectDatabaseCache()
  initializeDatabase()
  sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
})

afterAll(() => {
  clearProjectDatabaseCache()
  repoManager.cleanup()
})

describe('filesRouter GET /files/:ticketId/logs', () => {
  const app = new Hono()
  app.route('/api', filesRouter)

  it('reads normal, debug, and AI logs while preserving filters and folding upserts', async () => {
    const { ticket, paths } = createProjectTicket()

    writeJsonl(paths.executionLogPath, [
      {
        timestamp: '2026-03-13T12:00:00.000Z',
        type: 'info',
        ticketId: ticket.id,
        phase: 'CODING',
        phaseAttempt: 1,
        status: 'CODING',
        message: 'normal coding entry',
        content: 'normal coding entry',
      },
    ])
    writeJsonl(paths.debugLogPath, [
      {
        timestamp: '2026-03-13T12:00:01.000Z',
        type: 'debug',
        ticketId: ticket.id,
        phase: 'CODING',
        phaseAttempt: 1,
        status: 'CODING',
        message: 'debug attempt one',
        content: 'debug attempt one',
        source: 'debug',
      },
      {
        timestamp: '2026-03-13T12:00:02.000Z',
        type: 'debug',
        ticketId: ticket.id,
        phase: 'CODING',
        phaseAttempt: 2,
        status: 'CODING',
        message: 'debug attempt two',
        content: 'debug attempt two',
        source: 'debug',
      },
    ])
    writeJsonl(paths.aiLogPath, [
      {
        timestamp: '2026-03-13T12:00:03.000Z',
        type: 'model_output',
        ticketId: ticket.id,
        phase: 'CODING',
        phaseAttempt: 1,
        status: 'CODING',
        message: 'thinking partial',
        content: 'thinking partial',
        source: 'opencode',
        audience: 'ai',
        kind: 'reasoning',
        op: 'upsert',
        streaming: true,
        entryId: 'session:thinking',
      },
      {
        timestamp: '2026-03-13T12:00:04.000Z',
        type: 'model_output',
        ticketId: ticket.id,
        phase: 'CODING',
        phaseAttempt: 1,
        status: 'CODING',
        message: 'thinking latest',
        content: 'thinking latest',
        source: 'opencode',
        audience: 'ai',
        kind: 'reasoning',
        op: 'upsert',
        streaming: true,
        entryId: 'session:thinking',
      },
      {
        timestamp: '2026-03-13T12:00:05.000Z',
        type: 'model_output',
        ticketId: ticket.id,
        phase: 'CODING',
        phaseAttempt: 2,
        status: 'CODING',
        message: 'other attempt',
        content: 'other attempt',
        source: 'opencode',
        audience: 'ai',
        kind: 'reasoning',
        op: 'upsert',
        streaming: true,
        entryId: 'session:other',
      },
    ])

    const encodedTicketId = encodeURIComponent(ticket.id)
    const normalResponse = await app.request(`/api/files/${encodedTicketId}/logs?status=CODING&phase=CODING&phaseAttempt=1`)
    expect(normalResponse.status).toBe(200)
    const normalPayload = await normalResponse.json() as Array<Record<string, unknown>>
    expect(normalPayload.map((entry) => entry.content)).toEqual(['normal coding entry'])

    const debugResponse = await app.request(`/api/files/${encodedTicketId}/logs?channel=debug&status=CODING&phase=CODING&phaseAttempt=2`)
    expect(debugResponse.status).toBe(200)
    const debugPayload = await debugResponse.json() as Array<Record<string, unknown>>
    expect(debugPayload.map((entry) => entry.content)).toEqual(['debug attempt two'])
    expect(debugPayload.every((entry) => entry.source === 'debug')).toBe(true)

    const aiResponse = await app.request(`/api/files/${encodedTicketId}/logs?channel=ai&status=CODING&phase=CODING&phaseAttempt=1`)
    expect(aiResponse.status).toBe(200)
    const aiPayload = await aiResponse.json() as Array<Record<string, unknown>>
    expect(aiPayload.map((entry) => entry.content)).toEqual(['thinking latest'])
    expect(aiPayload.every((entry) => entry.audience === 'ai')).toBe(true)
  })

  it('filters native OpenCode entries on channel=all like every other source', async () => {
    const { ticket, paths } = createProjectTicket()
    writeJsonl(paths.aiLogPath, [
      {
        timestamp: '2026-03-13T12:00:00.000Z',
        type: 'model_output',
        sessionId: 'ses-1',
        phase: 'CODING',
        phaseAttempt: 1,
        status: 'CODING',
        message: 'ai entry',
        content: 'ai entry',
      },
    ])
    readOpenCodeNativeLogsMock.mockReturnValue([
      {
        timestamp: '2026-03-13T12:00:01.000Z',
        type: 'debug',
        source: 'debug',
        audience: 'debug',
        kind: 'session',
        op: 'append',
        phase: 'CODING',
        phaseAttempt: 1,
        status: 'CODING',
        message: 'native coding row',
        content: 'native coding row',
        sessionId: 'ses-1',
        data: { ocNativeLog: true },
      },
      {
        timestamp: '2026-03-13T12:00:02.000Z',
        type: 'debug',
        source: 'debug',
        audience: 'debug',
        kind: 'session',
        op: 'append',
        phase: 'opencode_native',
        phaseAttempt: 9,
        status: 'opencode_native',
        message: 'native row from another phase',
        content: 'native row from another phase',
        sessionId: 'ses-1',
        data: { ocNativeLog: true },
      },
    ] as never)

    const response = await app.request(
      `/api/files/${encodeURIComponent(ticket.id)}/logs?channel=all&phase=CODING&phaseAttempt=1`,
    )

    expect(response.status).toBe(200)
    const payload = await response.json() as Array<Record<string, unknown>>
    // Appended raw, the out-of-phase native row came back on every scoped
    // request for the ticket's sessions.
    expect(payload.map((entry) => entry.content)).toEqual(['ai entry', 'native coding row'])
  })

  it('puts a native entry with an unreadable timestamp last rather than first', async () => {
    const { ticket, paths } = createProjectTicket()
    writeJsonl(paths.executionLogPath, [
      {
        timestamp: '2026-03-13T12:00:05.000Z',
        type: 'info',
        phase: 'CODING',
        phaseAttempt: 1,
        status: 'CODING',
        message: 'dated entry',
        content: 'dated entry',
      },
    ])
    readOpenCodeNativeLogsMock.mockReturnValue([
      {
        timestamp: null,
        type: 'debug',
        source: 'debug',
        audience: 'debug',
        kind: 'session',
        op: 'append',
        phase: 'CODING',
        phaseAttempt: 1,
        status: 'CODING',
        message: 'undated native row',
        content: 'undated native row',
        sessionId: 'ses-1',
        data: { ocNativeLog: true },
      },
    ] as never)

    const response = await app.request(`/api/files/${encodeURIComponent(ticket.id)}/logs?channel=all`)

    const payload = await response.json() as Array<Record<string, unknown>>
    // Treated as epoch zero it sorted above everything, which is how a line
    // with no usable time ended up presented as the oldest event in the view.
    expect(payload.map((entry) => entry.content)).toEqual(['dated entry', 'undated native row'])
  })

  it('returns all matching log entries even when legacy limit parameters are present', async () => {
    const { ticket, paths } = createProjectTicket()
    writeJsonl(paths.debugLogPath, [
      { timestamp: '2026-03-13T12:00:00.000Z', message: 'first' },
      { timestamp: '2026-03-13T12:00:01.000Z', message: 'second' },
      { timestamp: '2026-03-13T12:00:02.000Z', message: 'third' },
    ])

    const response = await app.request(`/api/files/${encodeURIComponent(ticket.id)}/logs?channel=debug&limit=2`)

    expect(response.status).toBe(200)
    const payload = await response.json() as Array<Record<string, unknown>>
    expect(payload.map((entry) => entry.message)).toEqual(['first', 'second', 'third'])
  })
})

describe('recoverTicketRuntimeArtifacts', () => {
  it('repairs trailing corruption in normal, debug, and AI execution logs', () => {
    const { paths } = createProjectTicket()
    const normalEntry = JSON.stringify({ timestamp: '2026-03-13T12:00:00.000Z', message: 'normal' })
    const debugEntry = JSON.stringify({ timestamp: '2026-03-13T12:00:01.000Z', message: 'debug' })
    const aiEntry = JSON.stringify({ timestamp: '2026-03-13T12:00:02.000Z', message: 'ai', audience: 'ai' })

    mkdirSync(dirname(paths.executionLogPath), { recursive: true })
    writeFileSync(paths.executionLogPath, `${normalEntry}\n{"broken":`)
    writeFileSync(paths.debugLogPath, `${debugEntry}\n{"broken":`)
    writeFileSync(paths.aiLogPath, `${aiEntry}\n{"broken":`)

    const recovery = recoverTicketRuntimeArtifacts()

    expect(recovery.repairedExecutionLogs).toBe(3)
    expect(readFileSync(paths.executionLogPath, 'utf8')).toBe(`${normalEntry}\n`)
    expect(readFileSync(paths.debugLogPath, 'utf8')).toBe(`${debugEntry}\n`)
    expect(readFileSync(paths.aiLogPath, 'utf8')).toBe(`${aiEntry}\n`)
    expect(existsSync(paths.executionLogPath)).toBe(true)
    expect(existsSync(paths.debugLogPath)).toBe(true)
    expect(existsSync(paths.aiLogPath)).toBe(true)
  })
})

describe('cleanupTicketResources', () => {
  it('preserves normal, debug, and AI execution logs as audit artifacts', () => {
    const { ticket, paths } = createProjectTicket()
    writeJsonl(paths.executionLogPath, [{ timestamp: '2026-03-13T12:00:00.000Z', message: 'normal' }])
    writeJsonl(paths.debugLogPath, [{ timestamp: '2026-03-13T12:00:01.000Z', message: 'debug' }])
    writeJsonl(paths.aiLogPath, [{ timestamp: '2026-03-13T12:00:02.000Z', message: 'ai', audience: 'ai' }])

    const report = cleanupTicketResources(ticket.id)

    expect(report.status).toBe('clean')
    expect(report.errors).toEqual([])
    expect(report.preservedPaths).toContain(paths.executionLogPath)
    expect(report.preservedPaths).toContain(paths.debugLogPath)
    expect(report.preservedPaths).toContain(paths.aiLogPath)
    expect(existsSync(paths.executionLogPath)).toBe(true)
    expect(existsSync(paths.debugLogPath)).toBe(true)
    expect(existsSync(paths.aiLogPath)).toBe(true)
  })

  it('marks cleanup reports as warning when cleanup cannot find ticket resources', () => {
    const report = cleanupTicketResources('missing-ticket')

    expect(report.status).toBe('warning')
    expect(report.errors).toEqual(['Ticket directory not found'])
  })
})
