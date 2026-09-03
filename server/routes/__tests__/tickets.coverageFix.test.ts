import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { safeAtomicWrite } from '../../io/atomicWrite'
import { attachProject } from '../../storage/projects'
import {
  createTicket,
  getTicketPaths,
  patchTicket,
} from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { initializeTicket } from '../../ticket/initialize'
import { buildInterviewDocumentYaml } from '../../structuredOutput'
import { buildYamlDocument } from '../../structuredOutput/yamlUtils'
import { buildInterviewDocument, buildPrdDocument } from '../../test/factories'
import { contentSha256 } from '../../lib/contentHash'

const { performCoverageExtraFixMock } = vi.hoisted(() => ({
  performCoverageExtraFixMock: vi.fn(),
}))

vi.mock('../../workflow/phases/verificationPhase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workflow/phases/verificationPhase')>()
  return {
    ...actual,
    performCoverageExtraFix: performCoverageExtraFixMock,
  }
})

vi.mock('../../machines/persistence', async () => {
  const storage = await import('../../storage/tickets')

  return {
    createTicketActor: vi.fn(),
    ensureActorForTicket: vi.fn(() => ({ id: 'mock-actor' })),
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

const { ticketRouter } = await import('../tickets')

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-ticket-route-coverage-fix-',
  files: {
    'README.md': '# LoopTroop Coverage Fix Test\n',
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
    description: 'Verify coverage fix routes.',
  })

  const init = await initializeTicket({
    projectFolder: repoDir,
    externalId: ticket.externalId,
  })

  patchTicket(ticket.id, {
    status: 'WAITING_PRD_APPROVAL',
    branchName: init.branchName,
    lockedMainImplementer: 'openai/gpt-5-codex',
  })

  const paths = getTicketPaths(ticket.id)
  if (!paths) throw new Error('Ticket workspace not initialized')

  const interviewRaw = buildInterviewDocumentYaml(buildInterviewDocument(ticket.externalId))
  safeAtomicWrite(`${paths.ticketDir}/interview.yaml`, interviewRaw)
  const interviewHash = contentSha256(readFileSync(`${paths.ticketDir}/interview.yaml`, 'utf-8'))
  const prdRaw = buildYamlDocument(buildPrdDocument(ticket.externalId, interviewHash))
  safeAtomicWrite(`${paths.ticketDir}/prd.yaml`, prdRaw)

  const app = new Hono()
  app.route('/api', ticketRouter)
  return { app, ticket, prdRaw }
}

function coverageFixPayload(domain: 'prd' | 'beads') {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain }),
  }
}

describe('ticketRouter coverage gap fix route', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
    performCoverageExtraFixMock.mockReset()
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('rejects fix requests outside the matching approval status', async () => {
    const { app, ticket } = await setupPrdApprovalTicket()
    patchTicket(ticket.id, { status: 'DRAFTING_BEADS' })

    const response = await app.request(`/api/tickets/${ticket.id}/coverage/fix-gaps`, coverageFixPayload('prd'))

    expect(response.status).toBe(409)
    expect(performCoverageExtraFixMock).not.toHaveBeenCalled()
  })

  it('returns no-op success when the worker reports no open gaps', async () => {
    const { app, ticket } = await setupPrdApprovalTicket()
    performCoverageExtraFixMock.mockResolvedValue({
      domain: 'prd',
      status: 'clean',
      remainingGaps: [],
      extraFixNumber: null,
      changed: false,
      summary: 'No open coverage gaps remain.',
      noOp: true,
    })

    const response = await app.request(`/api/tickets/${ticket.id}/coverage/fix-gaps`, coverageFixPayload('prd'))

    expect(response.status).toBe(200)
    const payload = await response.json() as { message?: string; result?: { noOp?: boolean } }
    expect(payload.message).toBe('No open coverage gaps remain')
    expect(payload.result?.noOp).toBe(true)
  })

  it('ignores stale browser gap text and sends only server-owned context to the worker', async () => {
    const { app, ticket } = await setupPrdApprovalTicket()
    performCoverageExtraFixMock.mockResolvedValue({
      domain: 'prd',
      status: 'gaps',
      remainingGaps: ['Server gap remains.'],
      extraFixNumber: 1,
      changed: false,
      summary: 'Extra Fix 1 made no artifact changes; 1 gap remains in PRD Candidate v1.',
    })

    const response = await app.request(`/api/tickets/${ticket.id}/coverage/fix-gaps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'prd', gaps: ['Stale browser gap that must be ignored.'] }),
    })

    expect(response.status).toBe(200)
    expect(performCoverageExtraFixMock).toHaveBeenCalledTimes(1)
    const workerParams = performCoverageExtraFixMock.mock.calls[0]?.[0] as {
      ticketId?: string
      domain?: string
      context?: { lockedMainImplementer?: string }
    }
    expect(workerParams.ticketId).toBe(ticket.id)
    expect(workerParams.domain).toBe('prd')
    expect(workerParams.context?.lockedMainImplementer).toBe('openai/gpt-5-codex')
    expect(JSON.stringify(workerParams)).not.toContain('Stale browser gap that must be ignored.')
  })

  it('prevents concurrent fixes and blocks approval while a fix is running', async () => {
    const { app, ticket, prdRaw } = await setupPrdApprovalTicket()
    let resolveFix!: (value: unknown) => void
    const fixPromise = new Promise<unknown>((resolve) => {
      resolveFix = resolve
    })
    performCoverageExtraFixMock.mockImplementation(() => fixPromise)

    const firstRequest = app.request(`/api/tickets/${ticket.id}/coverage/fix-gaps`, coverageFixPayload('prd'))
    await vi.waitFor(() => {
      expect(performCoverageExtraFixMock).toHaveBeenCalledTimes(1)
    })

    const secondResponse = await app.request(`/api/tickets/${ticket.id}/coverage/fix-gaps`, coverageFixPayload('prd'))
    expect(secondResponse.status).toBe(409)

    const approvalResponse = await app.request(`/api/tickets/${ticket.id}/approve-prd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedContentSha256: contentSha256(prdRaw) }),
    })
    expect(approvalResponse.status).toBe(409)

    resolveFix({
      domain: 'prd',
      status: 'gaps',
      remainingGaps: ['Gap remains.'],
      extraFixNumber: 1,
      changed: true,
      summary: 'Extra Fix 1 revised PRD Candidate v1 into PRD Candidate v2; 1 gap remains.',
    })
    await firstRequest
  })
})
