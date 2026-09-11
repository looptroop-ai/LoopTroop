import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fstatSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import { createTicket, getTicketPaths } from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import * as fileReader from '../../io/readFile'
import { getManualQaStoragePaths, persistManualQaChecklist, resolveManualQaEvidence, streamManualQaEvidence } from '../../phases/manualQa/storage'
import { handleGetManualQaVersion, handleReadManualQaEvidence } from '../ticketHandlers/manualQaHandlers'

const repositories = createFixtureRepoManager({
  templatePrefix: 'looptroop-manual-qa-routes-', files: { 'README.md': '# Test\n' },
})
const app = new Hono()
app.get('/tickets/:id/manual-qa/versions/:version', handleGetManualQaVersion)
app.get('/tickets/:id/manual-qa/versions/:version/evidence/:itemId/:evidenceId', handleReadManualQaEvidence)

beforeEach(() => {
  clearProjectDatabaseCache()
  initializeDatabase()
  sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
})
afterEach(() => { vi.restoreAllMocks() })
afterAll(() => {
  clearProjectDatabaseCache()
  repositories.cleanup()
})

function setup() {
  const project = attachProject({ folderPath: repositories.createRepo(), name: 'Manual QA containment', shortname: 'MANQA' })
  const ticket = createTicket({ projectId: project.id, title: 'Manual QA files', description: '' })
  const paths = getTicketPaths(ticket.id)!
  persistManualQaChecklist(paths.ticketDir, {
    schemaVersion: 1, artifact: 'manual_qa_checklist', ticketId: ticket.externalId,
    version: 1, generatedAt: '2026-07-13T00:00:00.000Z', summary: 'Check behavior.', notApplicablePrdRefs: [],
    items: [{
      id: 'qa-v1-001', lineageId: 'lineage-001', title: 'Behavior', priorItemIds: [],
      source: 'implementation_diff', behavior: 'Works.', severity: 'required', recheckState: 'new',
      prerequisites: [], actions: ['Check behavior.'], expectedResult: 'Works.', watchNotes: [], beadRefs: [], prdRefs: [],
    }],
  })
  return { project, paths, url: `/tickets/${encodeURIComponent(ticket.id)}/manual-qa/versions/1` }
}

async function evidenceSetup() {
  const setupResult = setup()
  const content = 'public evidence'
  const metadata = await streamManualQaEvidence({
    ticketDir: setupResult.paths.ticketDir, version: 1, itemId: 'qa-v1-001', evidenceId: 'evidence-one',
    originalName: 'notes.txt', mediaType: 'text/plain',
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(content)); controller.close() } }),
  })
  const found = resolveManualQaEvidence({
    ticketDir: setupResult.paths.ticketDir, version: 1, itemId: metadata.itemId, evidenceId: metadata.id,
  })
  return { ...setupResult, path: found.path, content, url: `${setupResult.url}/evidence/${metadata.itemId}/${metadata.id}` }
}

describe('Manual QA route file containment', () => {
  it('reads an ordinary operation receipt but rejects an escaping final alias', async () => {
    const { project, paths, url } = setup()
    const operationPath = getManualQaStoragePaths(paths.ticketDir, 1).operationPath
    writeFileSync(operationPath, '{"actionId":"safe"}')
    const normal = await app.request(url)
    expect(normal.status).toBe(200)
    expect(await normal.json()).toMatchObject({ operation: { actionId: 'safe' } })
    renameSync(operationPath, `${operationPath}.held`)
    const outside = join(project.folderPath, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, operationPath, 'junction')

    const response = await app.request(url)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: expect.stringContaining('escapes root') })
  })

  it('rejects an evidence alias installed after resolution but before opening', async () => {
    const { project, path, url } = await evidenceSetup()
    const outside = join(project.folderPath, 'outside')
    mkdirSync(outside)
    const open = fileReader.openFileNoFollowSync
    vi.spyOn(fileReader, 'openFileNoFollowSync').mockImplementation((candidate, flags) => {
      if (candidate === path) {
        renameSync(path, `${path}.held`)
        symlinkSync(outside, path, 'junction')
      }
      return open(candidate, flags)
    })
    const response = await app.request(url)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: expect.stringContaining('regular file') })
  })

  it('streams the opened evidence descriptor when its pathname is replaced', async () => {
    const { path, url, content } = await evidenceSetup()
    const open = fileReader.openFileNoFollowSync
    let evidenceFd: number | undefined
    vi.spyOn(fileReader, 'openFileNoFollowSync').mockImplementation((candidate, flags) => {
      const fd = open(candidate, flags)
      if (candidate === path) {
        evidenceFd = fd
        renameSync(path, `${path}.held`)
        writeFileSync(path, 'unrelated replacement')
      }
      return fd
    })
    const response = await app.request(url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(content)
    expect(evidenceFd).toBeDefined()
    await vi.waitFor(() => { expect(() => fstatSync(evidenceFd!)).toThrow() })
  })

  it('closes the evidence descriptor when the response is canceled', async () => {
    const { path, url } = await evidenceSetup()
    const open = fileReader.openFileNoFollowSync
    let evidenceFd: number | undefined
    vi.spyOn(fileReader, 'openFileNoFollowSync').mockImplementation((candidate, flags) => {
      const fd = open(candidate, flags)
      if (candidate === path) evidenceFd = fd
      return fd
    })
    const response = await app.request(url)
    expect(response.status).toBe(200)
    expect(evidenceFd).toBeDefined()
    await response.body!.cancel()
    await vi.waitFor(() => { expect(() => fstatSync(evidenceFd!)).toThrow() })
  })
})
