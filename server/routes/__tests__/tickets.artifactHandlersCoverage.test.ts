import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import {
  archiveActivePhaseAttempts,
  createFreshPhaseAttempts,
  createTicket,
  getTicketPaths,
  insertPhaseArtifact,
  listPhaseArtifacts,
} from '../../storage/tickets'
import { contentSha256 } from '../../lib/contentHash'
import { createFixtureRepoManager } from '../../test/fixtureRepo'

vi.mock('../../workflow/runner', async () => (await import('../../test/routeMocks')).workflowRunnerMock())
vi.mock('../../opencode/sessionManager', async () => (await import('../../test/routeMocks')).sessionManagerMock())
vi.mock('../../opencode/contextBuilder', async () => (await import('../../test/routeMocks')).contextBuilderMock())
vi.mock('../../machines/persistence', async () => (await import('../../test/routeMocks')).machinesPersistenceMock())

import { ticketRouter } from '../tickets'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-artifact-handlers-coverage-',
  files: { 'README.md': '# Artifact handler route coverage\n' },
})
const app = new Hono()
app.route('/api', ticketRouter)

beforeEach(() => {
  clearProjectDatabaseCache()
  initializeDatabase()
  sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
})

afterAll(() => {
  clearProjectDatabaseCache()
  repoManager.cleanup()
})

function createArtifactTicket() {
  const project = attachProject({
    folderPath: repoManager.createRepo(),
    name: 'Artifact handler routes',
    shortname: 'ARTIFACT',
  })
  return createTicket({ projectId: project.id, title: 'Artifact route ticket', description: 'Exercise artifact reads.' })
}

function addArtifact(ticketId: string, artifactType: string, content: string, phaseAttempt?: number) {
  insertPhaseArtifact(ticketId, {
    phase: 'WAITING_PRD_APPROVAL',
    artifactType,
    content,
    ...(phaseAttempt === undefined ? {} : { phaseAttempt }),
  })
  return listPhaseArtifacts(ticketId, { phase: 'WAITING_PRD_APPROVAL', phaseAttempt })
    .find((artifact) => artifact.artifactType === artifactType)!
}

describe('ticketRouter artifact handler routes', () => {
  it('filters artifacts and manifests by the requested attempt, defaulting invalid filters to the active attempt', async () => {
    const ticket = createArtifactTicket()
    createFreshPhaseAttempts(ticket.id, ['WAITING_PRD_APPROVAL'])
    addArtifact(ticket.id, 'prd', '{"title":"Archived PRD"}', 1)
    archiveActivePhaseAttempts(ticket.id, ['WAITING_PRD_APPROVAL'], 'edited')
    createFreshPhaseAttempts(ticket.id, ['WAITING_PRD_APPROVAL'])
    addArtifact(ticket.id, 'prd', '{"title":"Current PRD","status":"approved"}', 2)

    const current = await app.request(`/api/tickets/${ticket.id}/artifacts?phase=WAITING_PRD_APPROVAL`)
    expect(current.status).toBe(200)
    expect(await current.json()).toMatchObject([{ artifactType: 'prd', phaseAttempt: 2, content: '{"title":"Current PRD","status":"approved"}' }])

    const archived = await app.request(`/api/tickets/${ticket.id}/artifacts?phase=WAITING_PRD_APPROVAL&phaseAttempt=1`)
    expect(await archived.json()).toMatchObject([{ artifactType: 'prd', phaseAttempt: 1, content: '{"title":"Archived PRD"}' }])

    const invalidAttempt = await app.request(`/api/tickets/${ticket.id}/artifacts?phase=WAITING_PRD_APPROVAL&phaseAttempt=NaN`)
    expect(await invalidAttempt.json()).toMatchObject([{ phaseAttempt: 2, content: '{"title":"Current PRD","status":"approved"}' }])

    const manifest = await app.request(`/api/tickets/${ticket.id}/artifacts/manifest?phase=WAITING_PRD_APPROVAL&phaseAttempt=1`)
    expect(await manifest.json()).toMatchObject({ artifacts: [{
      artifactType: 'prd',
      phaseAttempt: 1,
      contentByteCount: Buffer.byteLength('{"title":"Archived PRD"}', 'utf8'),
      contentSha256: contentSha256('{"title":"Archived PRD"}'),
      preview: { title: 'Archived PRD' },
      available: true,
    }] })

    const invalidManifestFilter = await app.request(`/api/tickets/${ticket.id}/artifacts/manifest?phase=WAITING_PRD_APPROVAL&phaseAttempt=-1`)
    const invalidManifestPayload = await invalidManifestFilter.json() as { artifacts: Array<Record<string, unknown>> }
    expect(invalidManifestPayload).toMatchObject({ artifacts: [{ phaseAttempt: 2, preview: { status: 'approved' } }] })
    expect(invalidManifestPayload.artifacts[0]).not.toHaveProperty('content')
  })

  it('serves artifact content with validators and returns not-modified for a matching ETag', async () => {
    const ticket = createArtifactTicket()
    const content = '{"title":"Review result","status":"passed"}'
    const artifact = addArtifact(ticket.id, 'review_result', content)
    const etag = `"${contentSha256(content)}"`

    const response = await app.request(`/api/tickets/${ticket.id}/artifacts/${artifact.id}/content`)
    expect(response.status).toBe(200)
    expect(response.headers.get('ETag')).toBe(etag)
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate')
    expect(await response.json()).toMatchObject({ artifact: { id: artifact.id, content, preview: { title: 'Review result', status: 'passed' } } })

    const notModified = await app.request(`/api/tickets/${ticket.id}/artifacts/${artifact.id}/content`, {
      headers: { 'If-None-Match': etag },
    })
    expect(notModified.status).toBe(304)
    expect(notModified.headers.get('ETag')).toBe(etag)
    expect(await notModified.text()).toBe('')

    for (const invalidId of ['0', '1.5', 'not-a-number', '9007199254740992']) {
      const invalid = await app.request(`/api/tickets/${ticket.id}/artifacts/${invalidId}/content`)
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toEqual({ error: 'Artifact id must be a positive integer' })
    }
    expect((await app.request(`/api/tickets/${ticket.id}/artifacts/999999/content`)).status).toBe(404)
  })

  it('validates artifact content batch JSON, shape, size, and numeric ids', async () => {
    const ticket = createArtifactTicket()
    const path = `/api/tickets/${ticket.id}/artifacts/content/batch`
    const post = (body: unknown) => app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const malformed = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'Expected a JSON body containing artifactIds' })

    for (const [body, error] of [
      [{}, 'artifactIds must contain at most 20 ids'],
      [{ artifactIds: Array.from({ length: 21 }, (_, index) => index + 1) }, 'artifactIds must contain at most 20 ids'],
      [{ artifactIds: [1, '2'] }, 'artifactIds must contain positive integer ids'],
      [{ artifactIds: [0] }, 'artifactIds must contain positive integer ids'],
    ] as const) {
      const response = await post(body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error })
    }
  })

  it('deduplicates requested artifact ids and reports missing or over-budget content', async () => {
    const ticket = createArtifactTicket()
    const small = addArtifact(ticket.id, 'small', 'keep this content')
    const tooLarge = addArtifact(ticket.id, 'large', 'x'.repeat(2 * 1024 * 1024 + 1))
    const path = `/api/tickets/${ticket.id}/artifacts/content/batch`

    const response = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artifactIds: [small.id, small.id, 999999, tooLarge.id] }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { artifacts: Array<{ id: number; content: string }>; omittedIds: number[] }
    expect(payload.artifacts).toMatchObject([{ id: small.id, content: 'keep this content' }])
    expect(payload.omittedIds).toEqual([999999, tooLarge.id])
  })

  it('reports an empty size breakdown when the ticket worktree is missing', async () => {
    const ticket = createArtifactTicket()
    const paths = getTicketPaths(ticket.id)!
    rmSync(paths.worktreePath, { recursive: true, force: true })

    const response = await app.request(`/api/tickets/${ticket.id}/size`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ size: 0, exists: false })
  })

  it('does not count a symlinked directory outside the ticket worktree', async () => {
    const ticket = createArtifactTicket()
    const paths = getTicketPaths(ticket.id)!
    const outsideDir = join(paths.projectRoot, 'outside-size-data')
    mkdirSync(outsideDir)
    writeFileSync(join(outsideDir, 'private.txt'), 'outside content that is not part of the worktree')
    symlinkSync(outsideDir, join(paths.worktreePath, 'linked-data'), 'junction')

    const response = await app.request(`/api/tickets/${ticket.id}/size`)
    expect(response.status).toBe(200)
    const payload = await response.json() as { breakdown: { source: { total: number; children: Array<{ name: string }> } } }
    expect(payload.breakdown.source.total).toBe(0)
    expect(payload.breakdown.source.children).not.toContainEqual(expect.objectContaining({ name: 'linked-data' }))
  })
})
