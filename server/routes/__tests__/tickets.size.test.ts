import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import { createTicket } from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { initializeTicket } from '../../ticket/initialize'

vi.mock('../../workflow/runner', async () => (await import('../../test/routeMocks')).workflowRunnerMock())

vi.mock('../../opencode/sessionManager', async () => (await import('../../test/routeMocks')).sessionManagerMock())

vi.mock('../../opencode/contextBuilder', async () => (await import('../../test/routeMocks')).contextBuilderMock())

vi.mock('../../machines/persistence', async () => (await import('../../test/routeMocks')).machinesPersistenceMock())

import { ticketRouter } from '../tickets'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-ticket-route-size-',
  files: {
    'README.md': '# LoopTroop Ticket Route Size Test\n',
  },
})

describe('ticketRouter GET /tickets/:id/size', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('calculates the size of a ticket worktree path recursively', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop Size',
      shortname: 'SIZE',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Size route test',
      description: 'Checks size reporting.',
    })

    const init = await initializeTicket({
      projectFolder: repoDir,
      externalId: ticket.externalId,
    })

    const app = new Hono()
    app.route('/api', ticketRouter)

    // Create some files under init.worktreePath to calculate size
    const file1 = join(init.worktreePath, 'test1.txt')
    const nestedDir = join(init.worktreePath, 'nested')
    const file2 = join(nestedDir, 'test2.txt')

    mkdirSync(nestedDir, { recursive: true })
    writeFileSync(file1, 'hello') // 5 bytes
    writeFileSync(file2, 'world!') // 6 bytes

    // Create a mock log file inside .ticket/runtime to check logs breakdown
    const ticketDir = join(init.worktreePath, '.ticket')
    const runtimeDir = join(ticketDir, 'runtime')
    mkdirSync(runtimeDir, { recursive: true })

    const logFile = join(runtimeDir, 'execution-log.jsonl')
    writeFileSync(logFile, 'logline') // 7 bytes

    const artifactFile = join(runtimeDir, 'some-artifact.json')
    writeFileSync(artifactFile, 'art') // 3 bytes

    const response = await app.request(`/api/tickets/${ticket.id}/size`)
    expect(response.status).toBe(200)

    interface SizeNode {
      name: string
      size: number
      isDirectory: boolean
      children?: SizeNode[]
    }
    const payload = await response.json() as {
      size: number
      exists: boolean
      breakdown: {
        logs: { total: number; children: SizeNode[] }
        artifacts: { total: number; children: SizeNode[] }
        source: { total: number; children: SizeNode[] }
      }
    }
    expect(payload.exists).toBe(true)
    // The total size is at least 21 bytes (5 + 6 + 7 + 3)
    expect(payload.size).toBeGreaterThanOrEqual(21)
    expect(payload.breakdown.logs.total).toBe(7)
    expect(payload.breakdown.artifacts.total).toBeGreaterThanOrEqual(3)
    expect(payload.breakdown.source.total).toBeGreaterThanOrEqual(11)

    // Verify children lists
    expect(payload.breakdown.logs.children.length).toBeGreaterThanOrEqual(1)
    expect(payload.breakdown.logs.children[0]!.name).toBe('execution-log.jsonl')
    expect(payload.breakdown.logs.children[0]!.size).toBe(7)

    expect(payload.breakdown.artifacts.children.length).toBeGreaterThanOrEqual(1)
    const runtimeNode = payload.breakdown.artifacts.children.find(c => c.name === 'runtime')
    expect(runtimeNode).toBeDefined()
    expect(runtimeNode!.children).toBeDefined()
    expect(runtimeNode!.children!.some(c => c.name === 'some-artifact.json')).toBe(true)

    expect(payload.breakdown.source.children.length).toBeGreaterThanOrEqual(2)
    expect(payload.breakdown.source.children.some(c => c.name === 'test1.txt')).toBe(true)
  })
})
