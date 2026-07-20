import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import {
  createTicket,
  getLatestPhaseArtifact,
  getTicketPaths,
  insertPhaseArtifact,
  patchTicket,
} from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { initializeTicket } from '../../ticket/initialize'
import { ticketRouter } from '../tickets'
import { beadsRouter } from '../beads'
import { contentSha256 } from '../../lib/contentHash'

vi.mock('../../machines/persistence', async () => {
  const storage = await import('../../storage/tickets')

  return {
    createTicketActor: vi.fn(),
    ensureActorForTicket: vi.fn(() => ({ id: 'mock-actor' })),
    sendTicketEvent: vi.fn((ticketRef: string | number, event: { type: string }) => {
      if (event.type === 'APPROVE') {
        storage.patchTicket(String(ticketRef), { status: 'PRE_FLIGHT_CHECK' })
      }
      return { value: event.type }
    }),
    getTicketState: vi.fn((ticketRef: string | number) => {
      const ticket = storage.getTicketByRef(String(ticketRef))
      if (!ticket) return null
      return { state: ticket.status, context: {}, status: 'active' }
    }),
    stopActor: vi.fn(() => true),
  }
})

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-ticket-route-beads-approval-',
  files: {
    'README.md': '# LoopTroop Beads Approval Test\n',
    'package.json': JSON.stringify({
      private: true,
      scripts: { test: 'echo test' },
    }, null, 2),
  },
})

function sampleBeadsJsonl(): string {
  const beads = [
    {
      id: 'bead-001',
      title: 'Setup database schema',
      description: 'Create the initial database schema.',
      prdRefs: ['E01-S01'],
      acceptanceCriteria: ['Schema is created', 'Migrations run'],
      tests: ['verify schema exists'],
      testCommands: ['npm test'],
      targetFiles: ['src/db/schema.ts'],
      contextGuidance: { patterns: ['use drizzle'], anti_patterns: ['raw SQL'] },
      dependencies: { blocked_by: [], blocks: ['bead-002'] },
      priority: 1,
      status: 'pending',
      issueType: 'task',
      labels: [],
    },
    {
      id: 'bead-002',
      title: 'Implement API endpoints',
      description: 'Create REST endpoints for the resource.',
      prdRefs: ['E01-S02'],
      acceptanceCriteria: ['GET returns 200', 'POST creates resource'],
      tests: ['API returns correct status codes'],
      testCommands: ['npm test'],
      targetFiles: ['src/routes/api.ts'],
      contextGuidance: { patterns: ['use Hono'], anti_patterns: ['express'] },
      dependencies: { blocked_by: ['bead-001'], blocks: [] },
      priority: 2,
      status: 'pending',
      issueType: 'task',
      labels: [],
    },
  ]
  return beads.map((b) => JSON.stringify(b)).join('\n') + '\n'
}

function setupBeadsApprovalTicket() {
  const repoDir = repoManager.createRepo()
  const project = attachProject({
    folderPath: repoDir,
    name: 'LoopTroop',
    shortname: 'LOOP',
  })
  const ticket = createTicket({
    projectId: project.id,
    title: 'Beads approval',
    description: 'Verify the beads approval routes.',
  })

  const init = initializeTicket({
    projectFolder: repoDir,
    externalId: ticket.externalId,
  })

  patchTicket(ticket.id, {
    status: 'WAITING_BEADS_APPROVAL',
    branchName: init.branchName,
  })

  const paths = getTicketPaths(ticket.id)
  if (!paths) {
    throw new Error('Ticket workspace not initialized')
  }

  // Write beads JSONL file
  const beadsDir = dirname(paths.beadsPath)
  mkdirSync(beadsDir, { recursive: true })
  const beadsContent = sampleBeadsJsonl()
  writeFileSync(paths.beadsPath, beadsContent)

  const app = new Hono()
  app.route('/api', ticketRouter)
  app.route('/api', beadsRouter)

  return { app, ticket, paths, beadsContent }
}

function approvalPayload(raw: string) {
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedContentSha256: contentSha256(raw) }),
  }
}

describe('ticketRouter beads approval routes', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('approves beads, stamps approval receipt, and advances the ticket', async () => {
    const { app, ticket, beadsContent } = setupBeadsApprovalTicket()

    const response = await app.request(`/api/tickets/${ticket.id}/approve-beads`, {
      method: 'POST',
      ...approvalPayload(beadsContent),
    })

    expect(response.status).toBe(200)
    const payload = (await response.json()) as { status?: string; message?: string }
    expect(payload.message).toBe('Beads approved')
    expect(payload.status).toBe('PRE_FLIGHT_CHECK')

    // Approval receipt stored as phase artifact
    const receipt = getLatestPhaseArtifact(ticket.id, 'approval_receipt', 'WAITING_BEADS_APPROVAL')
    expect(receipt).toBeDefined()
    const receiptData = JSON.parse(receipt!.content)
    expect(receiptData.approved_by).toBe('user')
    expect(receiptData.approved_at).toBeTruthy()
    expect(receiptData.bead_count).toBe(2)
    expect(receiptData.content_sha256).toBe(contentSha256(beadsContent))
  })

  it('dispatches beads approval through the generic approve route', async () => {
    const { app, ticket, beadsContent } = setupBeadsApprovalTicket()

    const response = await app.request(`/api/tickets/${ticket.id}/approve`, {
      method: 'POST',
      ...approvalPayload(beadsContent),
    })

    expect(response.status).toBe(200)
    const payload = (await response.json()) as { status?: string; message?: string }
    expect(payload.message).toBe('Beads approved')
    expect(payload.status).toBe('PRE_FLIGHT_CHECK')

    // Approval receipt is also stamped through the generic route
    const receipt = getLatestPhaseArtifact(ticket.id, 'approval_receipt', 'WAITING_BEADS_APPROVAL')
    expect(receipt).toBeDefined()
  })

  it('rejects beads approval when another project ticket is already in execution', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop Busy',
      shortname: 'BUSY',
    })
    const waitingTicket = createTicket({
      projectId: project.id,
      title: 'Waiting approval',
      description: 'Queued ticket.',
    })
    const runningTicket = createTicket({
      projectId: project.id,
      title: 'Running ticket',
      description: 'Already executing.',
    })

    const waitingInit = initializeTicket({
      projectFolder: repoDir,
      externalId: waitingTicket.externalId,
    })
    initializeTicket({
      projectFolder: repoDir,
      externalId: runningTicket.externalId,
    })

    patchTicket(waitingTicket.id, {
      status: 'WAITING_BEADS_APPROVAL',
      branchName: waitingInit.branchName,
    })
    patchTicket(runningTicket.id, {
      status: 'CODING',
      branchName: runningTicket.externalId,
    })

    const waitingPaths = getTicketPaths(waitingTicket.id)
    if (!waitingPaths) {
      throw new Error('Waiting ticket workspace not initialized')
    }
    mkdirSync(dirname(waitingPaths.beadsPath), { recursive: true })
    writeFileSync(waitingPaths.beadsPath, sampleBeadsJsonl())

    const busyApp = new Hono()
    busyApp.route('/api', ticketRouter)
    busyApp.route('/api', beadsRouter)

    const waitingBeadsContent = sampleBeadsJsonl()
    const response = await busyApp.request(`/api/tickets/${waitingTicket.id}/approve-beads`, {
      method: 'POST',
      ...approvalPayload(waitingBeadsContent),
    })

    expect(response.status).toBe(409)
    const payload = (await response.json()) as { error: string }
    expect(payload.error).toContain(runningTicket.externalId)
  })

  it('rejects approval when ticket is not in WAITING_BEADS_APPROVAL status', async () => {
    const { app, ticket, beadsContent } = setupBeadsApprovalTicket()

    patchTicket(ticket.id, { status: 'DRAFTING_BEADS' })

    const response = await app.request(`/api/tickets/${ticket.id}/approve-beads`, {
      method: 'POST',
      ...approvalPayload(beadsContent),
    })

    expect(response.status).toBe(409)
    const payload = (await response.json()) as { error: string }
    expect(payload.error).toContain('not waiting for beads approval')
  })

  it('returns 404 when ticket does not exist', async () => {
    const { app, beadsContent } = setupBeadsApprovalTicket()

    const response = await app.request('/api/tickets/9999/approve-beads', {
      method: 'POST',
      ...approvalPayload(beadsContent),
    })

    expect(response.status).toBe(404)
    const payload = (await response.json()) as { error: string }
    expect(payload.error).toContain('not found')
  })

  it('returns 500 when beads file is missing', async () => {
    const { app, ticket, paths, beadsContent } = setupBeadsApprovalTicket()

    // Remove beads file
    unlinkSync(paths.beadsPath)

    const response = await app.request(`/api/tickets/${ticket.id}/approve-beads`, {
      method: 'POST',
      ...approvalPayload(beadsContent),
    })

    expect(response.status).toBe(500)
    const payload = (await response.json()) as { error: string; details: string }
    expect(payload.details).toContain('not found')
  })

  it('returns stored diffs for uppercase bead ids', async () => {
    const { app, ticket } = setupBeadsApprovalTicket()

    insertPhaseArtifact(ticket.id, {
      phase: 'CODING',
      artifactType: 'bead_diff:MSEAR-1-001',
      content: 'diff --git a/file.ts b/file.ts',
    })

    const response = await app.request(`/api/tickets/${ticket.id}/beads/MSEAR-1-001/diff`)

    expect(response.status).toBe(200)
    const payload = await response.json() as { captured: boolean; diff: string }
    expect(payload).toEqual({
      captured: true,
      diff: 'diff --git a/file.ts b/file.ts',
    })
  })

  it('rejects malformed bead ids on the diff route', async () => {
    const { app, ticket } = setupBeadsApprovalTicket()

    const response = await app.request(`/api/tickets/${ticket.id}/beads/bad_id/diff`)

    expect(response.status).toBe(400)
    const payload = await response.json() as { error: string }
    expect(payload.error).toBe('Invalid bead ID')
  })

  it('returns 500 when beads file contains invalid JSON', async () => {
    const { app, ticket, paths } = setupBeadsApprovalTicket()

    // Write invalid JSON — first line has valid id+title, second has bad JSON
    const invalidContent = '{"id":"bead-001","title":"Valid bead"}\nnot valid json\n'
    writeFileSync(paths.beadsPath, invalidContent)

    const response = await app.request(`/api/tickets/${ticket.id}/approve-beads`, {
      method: 'POST',
      ...approvalPayload(invalidContent),
    })

    expect(response.status).toBe(500)
    const payload = (await response.json()) as { error: string; details: string }
    expect(payload.details).toContain('Invalid JSON at bead line 2')
  })

  it('stamps createdAt on all beads at approval time', async () => {
    const { app, ticket, paths, beadsContent } = setupBeadsApprovalTicket()

    const response = await app.request(`/api/tickets/${ticket.id}/approve-beads`, {
      method: 'POST',
      ...approvalPayload(beadsContent),
    })

    expect(response.status).toBe(200)

    // Approval should set createdAt to the approval timestamp on all beads
    const afterContent = readFileSync(paths.beadsPath, 'utf-8')
    const afterLines = afterContent.split('\n').filter(l => l.trim())
    for (const line of afterLines) {
      const parsed = JSON.parse(line) as Record<string, unknown>
      expect(typeof parsed.createdAt).toBe('string')
      expect(parsed.createdAt).not.toBe('')
    }
  })

  it('handles empty beads file gracefully', async () => {
    const { app, ticket, paths } = setupBeadsApprovalTicket()

    const emptyContent = '\n'
    writeFileSync(paths.beadsPath, emptyContent)

    const response = await app.request(`/api/tickets/${ticket.id}/approve-beads`, {
      method: 'POST',
      ...approvalPayload(emptyContent),
    })

    expect(response.status).toBe(500)
    const payload = (await response.json()) as { error: string; details: string }
    expect(payload.details).toContain('empty')
  })

  it('requires expectedContentSha256 for beads approval', async () => {
    const { app, ticket } = setupBeadsApprovalTicket()

    const response = await app.request(`/api/tickets/${ticket.id}/approve-beads`, {
      method: 'POST',
    })

    expect(response.status).toBe(400)
    const payload = await response.json() as { error?: string }
    expect(payload.error).toBe('Invalid approval payload')
  })

  it('rejects stale beads approval hashes with 409', async () => {
    const { app, ticket, beadsContent } = setupBeadsApprovalTicket()
    const expectedContentSha256 = '0'.repeat(64)

    const response = await app.request(`/api/tickets/${ticket.id}/approve-beads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedContentSha256 }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: 'Stale approval',
      artifactType: 'beads',
      expectedContentSha256,
      currentContentSha256: contentSha256(beadsContent),
    })
  })

  it('reads beads via GET endpoint', async () => {
    const { app, ticket } = setupBeadsApprovalTicket()

    const response = await app.request(`/api/tickets/${ticket.id}/beads`)

    expect(response.status).toBe(200)
    const data = (await response.json()) as unknown[]
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(2)
    expect((data[0] as Record<string, unknown>).id).toBe('bead-001')
    expect((data[1] as Record<string, unknown>).id).toBe('bead-002')
  })

  it('saves edited beads via PUT endpoint', async () => {
    const { app, ticket, paths } = setupBeadsApprovalTicket()

    const editedBeads = [
      {
        id: 'bead-001',
        title: 'Updated title',
        description: 'Updated description.',
        prdRefs: ['E01-S01'],
        acceptanceCriteria: ['Updated criterion'],
        tests: ['updated test'],
        testCommands: ['npm test'],
        targetFiles: ['src/db/schema.ts'],
        contextGuidance: { patterns: ['use drizzle'], anti_patterns: [] },
        dependencies: { blocked_by: [], blocks: [] },
        priority: 1,
        status: 'pending',
        issueType: 'task',
        labels: [],
      },
    ]

    const response = await app.request(`/api/tickets/${ticket.id}/beads`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editedBeads),
    })

    expect(response.status).toBe(200)

    const { readFileSync } = await import('node:fs')
    const savedContent = readFileSync(paths.beadsPath, 'utf-8')
    const lines = savedContent.split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(1)

    const savedBead = JSON.parse(lines[0]!)
    expect(savedBead.title).toBe('Updated title')
    expect(savedBead.description).toBe('Updated description.')
  })

  it('clears execution setup state when beads are edited', async () => {
    const { app, ticket, paths } = setupBeadsApprovalTicket()

    mkdirSync(paths.executionSetupDir, { recursive: true })
    writeFileSync(`${paths.executionSetupDir}/cache.txt`, 'warm\n')
    writeFileSync(paths.executionSetupProfilePath, '{"status":"ready"}\n')
    insertPhaseArtifact(ticket.id, {
      phase: 'PREPARING_EXECUTION_ENV',
      artifactType: 'execution_setup_profile',
      content: '{"status":"ready"}',
    })

    const response = await app.request(`/api/tickets/${ticket.id}/beads`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        {
          id: 'bead-001',
          title: 'Retouched bead',
          description: 'Updated description.',
          prdRefs: ['E01-S01'],
          acceptanceCriteria: ['Updated criterion'],
          tests: ['updated test'],
          testCommands: ['npm test'],
          targetFiles: ['src/db/schema.ts'],
          contextGuidance: { patterns: ['use drizzle'], anti_patterns: [] },
          dependencies: { blocked_by: [], blocks: [] },
          priority: 1,
          status: 'pending',
          issueType: 'task',
          labels: [],
        },
      ]),
    })

    expect(response.status).toBe(200)
    expect(getLatestPhaseArtifact(ticket.id, 'execution_setup_profile', 'PREPARING_EXECUTION_ENV')).toBeUndefined()

    expect(existsSync(paths.executionSetupDir)).toBe(false)
    expect(existsSync(paths.executionSetupProfilePath)).toBe(false)
  })
})
