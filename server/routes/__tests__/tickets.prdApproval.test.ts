import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { safeAtomicWrite } from '../../io/atomicWrite'
import { attachProject } from '../../storage/projects'
import {
  createFreshPhaseAttempts,
  createTicket,
  getLatestPhaseArtifact,
  getTicketByRef,
  getTicketPaths,
  patchTicket,
  PRD_EDIT_RESTART_PHASES,
  upsertLatestPhaseArtifact,
} from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { initializeTicket } from '../../ticket/initialize'
import { buildInterviewDocumentYaml } from '../../structuredOutput'
import { buildYamlDocument } from '../../structuredOutput/yamlUtils'
import { ticketRouter } from '../tickets'
import { filesRouter } from '../files'
import { buildInterviewDocument, buildPrdDocument } from '../../test/factories'
import type { PrdDocument } from '../../structuredOutput/types'
import { contentSha256 } from '../../lib/contentHash'
import { listSkipEvents } from '../../workflow/skipReceipts'

vi.mock('../../machines/persistence', async () => {
  const storage = await import('../../storage/tickets')

  return {
    createTicketActor: vi.fn(),
    ensureActorForTicket: vi.fn(() => ({ id: 'mock-actor' })),
    revertTicketToApprovalStatus: vi.fn((ticketRef: string | number, status: string) => {
      storage.patchTicket(String(ticketRef), { status })
      return { id: 'mock-actor', status }
    }),
    sendTicketEvent: vi.fn((ticketRef: string | number, event: { type: string }) => {
      if (event.type === 'APPROVE') {
        storage.patchTicket(String(ticketRef), { status: 'DRAFTING_BEADS' })
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
  templatePrefix: 'looptroop-ticket-route-prd-approval-',
  files: {
    'README.md': '# LoopTroop PRD Approval Test\n',
  },
})

async function setupPrdApprovalTicket() {
  const repoDir = repoManager.createRepo()
  const project = attachProject({
    folderPath: repoDir,
    name: 'LoopTroop',
    shortname: 'LOOP',
  })
  const ticket = createTicket({
    projectId: project.id,
    title: 'PRD approval',
    description: 'Verify the PRD approval routes.',
  })

  const init = await initializeTicket({
    projectFolder: repoDir,
    externalId: ticket.externalId,
  })

  patchTicket(ticket.id, {
    status: 'WAITING_PRD_APPROVAL',
    branchName: init.branchName,
  })

  const paths = getTicketPaths(ticket.id)
  if (!paths) {
    throw new Error('Ticket workspace not initialized')
  }

  // Write approved interview.yaml (required for PRD normalization hash)
  const interviewDoc = buildInterviewDocument(ticket.externalId)
  const interviewRaw = buildInterviewDocumentYaml(interviewDoc)
  safeAtomicWrite(`${paths.ticketDir}/interview.yaml`, interviewRaw)

  // Build and write prd.yaml
  const interviewContentForHash = readFileSync(`${paths.ticketDir}/interview.yaml`, 'utf-8')
  const interviewHash = contentSha256(interviewContentForHash)
  const prdDoc = buildPrdDocument(ticket.externalId, interviewHash)
  const prdRaw = buildYamlDocument(prdDoc)
  safeAtomicWrite(`${paths.ticketDir}/prd.yaml`, prdRaw)

  const app = new Hono()
  app.route('/api', ticketRouter)
  app.route('/api', filesRouter)

  return { app, ticket, paths, prdRaw }
}

function approvalPayload(raw: string) {
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedContentSha256: contentSha256(raw) }),
  }
}

describe('ticketRouter PRD approval routes', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('approves the PRD, stamps approval metadata, and advances the ticket', async () => {
    const { app, ticket, paths, prdRaw } = await setupPrdApprovalTicket()

    const response = await app.request(`/api/tickets/${ticket.id}/approve-prd`, {
      method: 'POST',
      ...approvalPayload(prdRaw),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { status?: string; message?: string }
    expect(payload.message).toBe('PRD approved')
    expect(payload.status).toBe('DRAFTING_BEADS')

    const savedRaw = readFileSync(`${paths.ticketDir}/prd.yaml`, 'utf-8')
    expect(savedRaw).toContain('status: approved')
    expect(savedRaw).toContain('approved_by: user')
    expect(savedRaw).toMatch(/approved_at: .+/)

    const receipt = getLatestPhaseArtifact(ticket.id, 'approval_receipt', 'WAITING_PRD_APPROVAL')
    expect(receipt).toBeDefined()
    const receiptData = JSON.parse(receipt!.content)
    expect(receiptData.content_sha256).toBe(contentSha256(prdRaw))
    expect(receiptData.stored_content_sha256).toBe(contentSha256(savedRaw))
  })

  it('validates raw PRD YAML, canonicalizes it, and forces draft status on save', async () => {
    const { app, ticket, paths } = await setupPrdApprovalTicket()

    const response = await app.request(`/api/files/${ticket.id}/prd`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: [
          'schema_version: 1',
          'ticket_id: WRONG-ID',
          'artifact: prd',
          'status: approved',
          'source_interview:',
          '  content_sha256: 0000000000000000000000000000000000000000000000000000000000000000',
          'product:',
          '  problem_statement: Import pipeline needs resilience.',
          '  target_users:',
          '    - Backend engineers',
          'scope:',
          '  in_scope:',
          '    - Retry logic',
          '  out_of_scope:',
          '    - Bulk reprocessing UI',
          'technical_requirements:',
          '  architecture_constraints:',
          '    - Must integrate with existing queue',
          '  data_model: []',
          '  api_contracts: []',
          '  security_constraints: []',
          '  performance_constraints: []',
          '  reliability_constraints: []',
          '  error_handling_rules: []',
          '  tooling_assumptions: []',
          'epics:',
          '  - id: E01',
          '    title: Retry infrastructure',
          '    objective: Build retry mechanism.',
          '    implementation_steps:',
          '      - Add retry queue',
          '    user_stories:',
          '      - id: E01-S01',
          '        title: Retry a failed import',
          '        acceptance_criteria:',
          '          - Import is retried',
          '        implementation_steps:',
          '          - Create retry handler',
          '        verification:',
          '          required_commands:',
          '            - npm test',
          'risks:',
          '  - Queue saturation',
          'approval:',
          '  approved_by: user',
          '  approved_at: 2026-03-20T10:10:00.000Z',
        ].join('\n'),
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { success: boolean; content: string }
    expect(payload.success).toBe(true)

    const savedRaw = readFileSync(`${paths.ticketDir}/prd.yaml`, 'utf-8')
    expect(savedRaw).toContain(`ticket_id: ${ticket.externalId}`)
    expect(savedRaw).toContain('status: draft')
    expect(savedRaw).not.toContain('WRONG-ID')

    // Approval fields are cleared on draft save
    expect(savedRaw).toContain("approved_by: ''")
    expect(savedRaw).toContain("approved_at: ''")
  })

  it('accepts structured PRD saves, canonicalizes them, and clears approval metadata', async () => {
    const { app, ticket, paths } = await setupPrdApprovalTicket()

    const structuredDocument: PrdDocument = {
      ...buildPrdDocument(ticket.externalId, '0000000000000000000000000000000000000000000000000000000000000000'),
      ticket_id: 'WRONG-ID',
      status: 'approved',
      approval: {
        approved_by: 'user',
        approved_at: '2026-03-20T10:10:00.000Z',
      },
    }

    const response = await app.request(`/api/files/${ticket.id}/prd`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        document: structuredDocument,
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { success: boolean; content: string }
    expect(payload.success).toBe(true)
    expect(payload.content).toContain(`ticket_id: ${ticket.externalId}`)
    expect(payload.content).toContain('status: draft')
    expect(payload.content).toContain("approved_by: ''")
    expect(payload.content).toContain("approved_at: ''")

    const savedRaw = readFileSync(`${paths.ticketDir}/prd.yaml`, 'utf-8')
    expect(savedRaw).toContain(`ticket_id: ${ticket.externalId}`)
    expect(savedRaw).toContain('status: draft')
    expect(savedRaw).toContain("approved_by: ''")
    expect(savedRaw).toContain("approved_at: ''")
  })

  it('rejects invalid raw PRD YAML without overwriting the current artifact', async () => {
    const { app, ticket, prdRaw, paths } = await setupPrdApprovalTicket()

    const response = await app.request(`/api/files/${ticket.id}/prd`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'artifact: prd\nepics: [',
      }),
    })

    expect(response.status).toBe(400)
    const savedRaw = readFileSync(`${paths.ticketDir}/prd.yaml`, 'utf-8')
    expect(savedRaw).toBe(prdRaw)
  })

  it('rejects invalid structured PRD documents without overwriting the current artifact', async () => {
    const { app, ticket, prdRaw, paths } = await setupPrdApprovalTicket()

    const response = await app.request(`/api/files/${ticket.id}/prd`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        document: {},
      }),
    })

    expect(response.status).toBe(400)
    const savedRaw = readFileSync(`${paths.ticketDir}/prd.yaml`, 'utf-8')
    expect(savedRaw).toBe(prdRaw)
  })

  it('rejects raw PRD edits at pre-flight or later', async () => {
    const { app, ticket, prdRaw, paths } = await setupPrdApprovalTicket()
    patchTicket(ticket.id, { status: 'PRE_FLIGHT_CHECK' })

    const response = await app.request(`/api/files/${ticket.id}/prd`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: prdRaw,
      }),
    })

    expect(response.status).toBe(409)
    const savedRaw = readFileSync(`${paths.ticketDir}/prd.yaml`, 'utf-8')
    expect(savedRaw).toBe(prdRaw)
  })

  it('rejects structured PRD edits at pre-flight or later', async () => {
    const { app, ticket, prdRaw, paths } = await setupPrdApprovalTicket()
    patchTicket(ticket.id, { status: 'PRE_FLIGHT_CHECK' })

    const response = await app.request(`/api/files/${ticket.id}/prd`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        document: buildPrdDocument(ticket.externalId, '0000000000000000000000000000000000000000000000000000000000000000'),
      }),
    })

    expect(response.status).toBe(409)
    const savedRaw = readFileSync(`${paths.ticketDir}/prd.yaml`, 'utf-8')
    expect(savedRaw).toBe(prdRaw)
  })

  it('clears downstream beads artifacts and writes an edit receipt when PRD is edited', async () => {
    const { app, ticket, paths, prdRaw } = await setupPrdApprovalTicket()

    // Create beads/ directory and a beads artifact in the DB
    const beadsDir = resolve(paths.ticketDir, 'beads')
    mkdirSync(beadsDir, { recursive: true })
    writeFileSync(resolve(beadsDir, 'bead-001.yaml'), 'artifact: bead\n')
    upsertLatestPhaseArtifact(ticket.id, 'beads', 'DRAFTING_BEADS', 'artifact: beads\n')
    upsertLatestPhaseArtifact(ticket.id, 'ui_state:approval_beads', 'UI_STATE', '{"data":{}}')

    const response = await app.request(`/api/files/${ticket.id}/prd`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: [
          'schema_version: 1',
          'artifact: prd',
          'status: draft',
          'source_interview:',
          '  content_sha256: placeholder',
          'product:',
          '  problem_statement: Updated problem statement for retry pipeline.',
          '  target_users:',
          '    - Backend engineers',
          'scope:',
          '  in_scope:',
          '    - Updated retry logic',
          '  out_of_scope:',
          '    - Bulk reprocessing UI',
          'technical_requirements:',
          '  architecture_constraints:',
          '    - Must integrate with existing queue',
          '  data_model: []',
          '  api_contracts: []',
          '  security_constraints: []',
          '  performance_constraints: []',
          '  reliability_constraints: []',
          '  error_handling_rules: []',
          '  tooling_assumptions: []',
          'epics:',
          '  - id: E01',
          '    title: Retry infrastructure',
          '    objective: Build retry mechanism.',
          '    implementation_steps:',
          '      - Add retry queue',
          '    user_stories:',
          '      - id: E01-S01',
          '        title: Retry a failed import',
          '        acceptance_criteria:',
          '          - Import is retried',
          '        implementation_steps:',
          '          - Create retry handler',
          '        verification:',
          '          required_commands:',
          '            - npm test',
          'risks:',
          '  - Queue saturation',
          'approval:',
          "  approved_by: ''",
          "  approved_at: ''",
        ].join('\n'),
      }),
    })

    expect(response.status).toBe(200)
    expect(existsSync(beadsDir)).toBe(false)
    expect(getLatestPhaseArtifact(ticket.id, 'beads', 'DRAFTING_BEADS')).toBeUndefined()
    expect(getLatestPhaseArtifact(ticket.id, 'ui_state:approval_beads', 'UI_STATE')).toBeUndefined()

    const savedRaw = readFileSync(`${paths.ticketDir}/prd.yaml`, 'utf-8')
    const receipt = getLatestPhaseArtifact(ticket.id, 'user_edit_receipt:prd', 'WAITING_PRD_APPROVAL')
    expect(receipt).toBeDefined()
    const receiptData = JSON.parse(receipt!.content)
    expect(receiptData).toMatchObject({
      target_artifact: 'prd',
      action: 'save',
      edit_surface: 'raw',
      before: {
        sha256: contentSha256(prdRaw),
        item_count: 2,
      },
      after: {
        sha256: contentSha256(savedRaw),
        item_count: 2,
      },
    })
    expect(receiptData.invalidation.invalidated_phases).toContain('WAITING_BEADS_APPROVAL')
  })

  it('archives approval and beads attempts, approves the edit, and starts beads drafting when PRD is edited from a later phase', async () => {
    const { app, ticket, paths, prdRaw } = await setupPrdApprovalTicket()
    upsertLatestPhaseArtifact(
      ticket.id,
      'approval_snapshot:prd',
      'WAITING_PRD_APPROVAL',
      JSON.stringify({ raw: prdRaw }),
    )
    patchTicket(ticket.id, { status: 'WAITING_BEADS_APPROVAL' })
    createFreshPhaseAttempts(ticket.id, PRD_EDIT_RESTART_PHASES)

    const beadsDir = resolve(paths.ticketDir, 'beads')
    mkdirSync(beadsDir, { recursive: true })
    writeFileSync(resolve(beadsDir, 'bead-001.yaml'), 'artifact: bead\n')
    upsertLatestPhaseArtifact(ticket.id, 'beads', 'DRAFTING_BEADS', 'artifact: beads\n')
    upsertLatestPhaseArtifact(
      ticket.id,
      'approval_snapshot:beads',
      'WAITING_BEADS_APPROVAL',
      JSON.stringify({ raw: '{"id":"bead-1","title":"Archived bead"}\n' }),
    )

    const response = await app.request(`/api/files/${ticket.id}/prd`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: [
          'schema_version: 1',
          `ticket_id: ${ticket.externalId}`,
          'artifact: prd',
          'status: draft',
          'source_interview:',
          '  content_sha256: 0000000000000000000000000000000000000000000000000000000000000000',
          'product:',
          '  problem_statement: Restart beads planning from edited PRD.',
          '  target_users:',
          '    - Backend engineers',
          'scope:',
          '  in_scope:',
          '    - Restart beads planning',
          '  out_of_scope:',
          '    - Execution changes',
          'technical_requirements:',
          '  architecture_constraints:',
          '    - Preserve archived attempt history',
          '  data_model: []',
          '  api_contracts: []',
          '  security_constraints: []',
          '  performance_constraints: []',
          '  reliability_constraints: []',
          '  error_handling_rules: []',
          '  tooling_assumptions: []',
          'epics:',
          '  - id: E01',
          '    title: Restart beads history',
          '    objective: Create a fresh active beads attempt.',
          '    implementation_steps:',
          '      - Archive downstream attempts',
          '    user_stories:',
          '      - id: E01-S01',
          '        title: Keep archived beads read-only',
          '        acceptance_criteria:',
          '          - Old beads remain inspectable',
          '        implementation_steps:',
          '          - Keep attempt history in DB',
          '        verification:',
          '          required_commands:',
          '            - npm test',
          'risks: []',
          'approval:',
          "  approved_by: ''",
          "  approved_at: ''",
        ].join('\n'),
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { content: string; status?: string }
    expect(payload.status).toBe('DRAFTING_BEADS')
    expect(payload.content).toContain('status: approved')
    expect(payload.content).toContain('approved_by: user')
    expect(existsSync(beadsDir)).toBe(false)
    expect(readFileSync(`${paths.ticketDir}/prd.yaml`, 'utf-8')).toContain('status: approved')

    const prdAttemptsResponse = await app.request(`/api/tickets/${ticket.id}/phases/WAITING_PRD_APPROVAL/attempts`)
    expect(prdAttemptsResponse.status).toBe(200)
    const prdAttempts = await prdAttemptsResponse.json() as Array<{ attemptNumber: number; state: string; archivedReason: string | null }>
    expect(prdAttempts[0]).toMatchObject({ attemptNumber: 2, state: 'active' })
    expect(prdAttempts[1]).toMatchObject({
      attemptNumber: 1,
      state: 'archived',
      archivedReason: 'prd_edit_restart',
    })

    const archivedPrdArtifactsResponse = await app.request(`/api/tickets/${ticket.id}/artifacts?phase=WAITING_PRD_APPROVAL&phaseAttempt=1`)
    expect(archivedPrdArtifactsResponse.status).toBe(200)
    const archivedPrdArtifacts = await archivedPrdArtifactsResponse.json() as Array<{ artifactType: string; phaseAttempt: number }>
    expect(archivedPrdArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifactType: 'approval_snapshot:prd',
        phaseAttempt: 1,
      }),
    ]))

    const attemptsResponse = await app.request(`/api/tickets/${ticket.id}/phases/WAITING_BEADS_APPROVAL/attempts`)
    expect(attemptsResponse.status).toBe(200)
    const attempts = await attemptsResponse.json() as Array<{ attemptNumber: number; state: string }>
    expect(attempts[0]).toMatchObject({ attemptNumber: 2, state: 'active' })
    expect(attempts[1]).toMatchObject({ attemptNumber: 1, state: 'archived' })

    const defaultArtifactsResponse = await app.request(`/api/tickets/${ticket.id}/artifacts?phase=WAITING_BEADS_APPROVAL`)
    expect(defaultArtifactsResponse.status).toBe(200)
    const defaultArtifacts = await defaultArtifactsResponse.json() as Array<{ artifactType: string }>
    expect(defaultArtifacts).toEqual([])

    const archivedArtifactsResponse = await app.request(`/api/tickets/${ticket.id}/artifacts?phase=WAITING_BEADS_APPROVAL&phaseAttempt=1`)
    expect(archivedArtifactsResponse.status).toBe(200)
    const archivedArtifacts = await archivedArtifactsResponse.json() as Array<{ artifactType: string; phaseAttempt: number }>
    expect(archivedArtifacts).toEqual([
      expect.objectContaining({
        artifactType: 'approval_snapshot:beads',
        phaseAttempt: 1,
      }),
    ])
  })

  it('does not archive attempts when a post-approval PRD edit is invalid', async () => {
    const { app, ticket } = await setupPrdApprovalTicket()
    patchTicket(ticket.id, { status: 'WAITING_BEADS_APPROVAL' })
    createFreshPhaseAttempts(ticket.id, PRD_EDIT_RESTART_PHASES)

    const response = await app.request(`/api/files/${ticket.id}/prd`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'artifact: prd\nepics: [',
      }),
    })

    expect(response.status).toBe(400)
    expect(getTicketByRef(ticket.id)?.status).toBe('WAITING_BEADS_APPROVAL')

    const attemptsResponse = await app.request(`/api/tickets/${ticket.id}/phases/WAITING_PRD_APPROVAL/attempts`)
    expect(attemptsResponse.status).toBe(200)
    const attempts = await attemptsResponse.json() as Array<{ attemptNumber: number; state: string; archivedReason: string | null }>
    expect(attempts).toEqual([
      expect.objectContaining({ attemptNumber: 1, state: 'active', archivedReason: null }),
    ])
    expect(getLatestPhaseArtifact(ticket.id, 'user_edit_receipt:prd', 'WAITING_PRD_APPROVAL')).toBeUndefined()
  })

  it('stamps PRD approval metadata through the generic approve route', async () => {
    const { app, ticket, paths, prdRaw } = await setupPrdApprovalTicket()

    const response = await app.request(`/api/tickets/${ticket.id}/approve`, {
      method: 'POST',
      ...approvalPayload(prdRaw),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { message?: string; status?: string }
    expect(payload.message).toBe('PRD approved')
    expect(payload.status).toBe('DRAFTING_BEADS')

    const savedRaw = readFileSync(`${paths.ticketDir}/prd.yaml`, 'utf-8')
    expect(savedRaw).toContain('status: approved')
    expect(savedRaw).toContain('approved_by: user')
    expect(savedRaw).toMatch(/approved_at: .+/)
  })

  it('rejects approval when ticket is not in WAITING_PRD_APPROVAL status', async () => {
    const { app, ticket, prdRaw } = await setupPrdApprovalTicket()

    patchTicket(ticket.id, { status: 'DRAFTING_PRD' })

    const response = await app.request(`/api/tickets/${ticket.id}/approve-prd`, {
      method: 'POST',
      ...approvalPayload(prdRaw),
    })

    expect(response.status).toBe(409)
    const payload = await response.json() as { error: string }
    expect(payload.error).toContain('not waiting for PRD approval')
  })

  it('requires expectedContentSha256 for PRD approval', async () => {
    const { app, ticket } = await setupPrdApprovalTicket()

    const response = await app.request(`/api/tickets/${ticket.id}/approve-prd`, {
      method: 'POST',
    })

    expect(response.status).toBe(400)
    const payload = await response.json() as { error?: string }
    expect(payload.error).toBe('Invalid approval payload')
  })

  it('requires expectedContentSha256 for generic approval', async () => {
    const { app, ticket } = await setupPrdApprovalTicket()

    const response = await app.request(`/api/tickets/${ticket.id}/approve`, {
      method: 'POST',
    })

    expect(response.status).toBe(400)
    const payload = await response.json() as { error?: string }
    expect(payload.error).toBe('Invalid approval payload')
  })

  it('rejects stale PRD approval hashes with 409', async () => {
    const { app, ticket, prdRaw } = await setupPrdApprovalTicket()
    const expectedContentSha256 = '0'.repeat(64)

    const response = await app.request(`/api/tickets/${ticket.id}/approve-prd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedContentSha256 }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: 'Stale approval',
      artifactType: 'prd',
      expectedContentSha256,
      currentContentSha256: contentSha256(prdRaw),
    })
  })

  it('rejects stale PRD approval hashes through the generic approve route with 409', async () => {
    const { app, ticket, prdRaw } = await setupPrdApprovalTicket()
    const expectedContentSha256 = '1'.repeat(64)

    const response = await app.request(`/api/tickets/${ticket.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedContentSha256 }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: 'Stale approval',
      artifactType: 'prd',
      expectedContentSha256,
      currentContentSha256: contentSha256(prdRaw),
    })
  })

  it('refuses the generic approve route on a status that cannot be approved', async () => {
    const { app, ticket } = await setupPrdApprovalTicket()
    patchTicket(ticket.id, { status: 'CODING' })

    const response = await app.request(`/api/tickets/${ticket.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    // Refused, not accepted. Whichever of the handler's two checks answers, the
    // contract is the same: an approve on a status that cannot be approved is a
    // 409, never a 200 reporting an action the machine ignored.
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'Ticket is not in an approval state' })
  })

  it('records why the PRD was approved with known coverage gaps', async () => {
    const { app, ticket, prdRaw } = await setupPrdApprovalTicket()

    const response = await app.request(`/api/tickets/${ticket.id}/approve-prd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedContentSha256: contentSha256(prdRaw),
        gapAcknowledgementReason: 'The remaining gap is tracked in a follow-up ticket.',
      }),
    })

    expect(response.status).toBe(200)

    const receipt = getLatestPhaseArtifact(ticket.id, 'approval_receipt', 'WAITING_PRD_APPROVAL')
    expect(JSON.parse(receipt!.content).gap_acknowledgement).toEqual({
      reason: 'The remaining gap is tracked in a follow-up ticket.',
    })

    const events = listSkipEvents(ticket.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      surface: 'approval_with_gaps',
      itemId: 'prd',
      reason: 'The remaining gap is tracked in a follow-up ticket.',
    })
  })

  it('leaves the approval receipt alone when no gap reason was given', async () => {
    const { app, ticket, prdRaw } = await setupPrdApprovalTicket()

    const response = await app.request(`/api/tickets/${ticket.id}/approve-prd`, {
      method: 'POST',
      ...approvalPayload(prdRaw),
    })

    expect(response.status).toBe(200)
    const receipt = getLatestPhaseArtifact(ticket.id, 'approval_receipt', 'WAITING_PRD_APPROVAL')
    expect(JSON.parse(receipt!.content).gap_acknowledgement).toBeUndefined()
    expect(listSkipEvents(ticket.id)).toHaveLength(0)
  })
})
