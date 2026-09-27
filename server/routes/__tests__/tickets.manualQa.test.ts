import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { insertPhaseArtifact, patchTicket } from '../../storage/tickets'
import { captureFinalTestDirtyFiles, buildFinalTestFileEffectsAudit } from '../../phases/finalTest/fileEffectsAudit'
import { prepareManualQaCheckpoint } from '../../phases/manualQa/checkpoint'
import {
  getManualQaChecklistHash,
  persistManualQaChecklist,
  persistManualQaEvidenceActionReceipt,
  readManualQaEvidenceIndex,
  streamManualQaEvidence,
} from '../../phases/manualQa/storage'
import type { ManualQaChecklist, ManualQaDraft } from '../../phases/manualQa/types'

vi.mock('../../machines/persistence', async () => (await import('../../test/routeMocks')).machinesPersistenceMock())

import { ensureActorForTicket, sendTicketEvent } from '../../machines/persistence'
import { ticketRouter } from '../tickets'

const repoManager = createTestRepoManager('manual-qa-route-')
const app = new Hono()
app.route('/api', ticketRouter)

function checklistItem(id: string): ManualQaChecklist['items'][number] {
  return {
    id,
    lineageId: `lineage-${id}`,
    priorItemIds: [],
    title: `Verify ${id}`,
    source: 'implementation_diff',
    behavior: `${id} remains usable`,
    severity: 'required',
    recheckState: 'new',
    prerequisites: [],
    actions: [`Exercise ${id}`],
    expectedResult: `${id} works`,
    watchNotes: [],
    beadRefs: [],
    prdRefs: [],
  }
}

async function setup(items = [checklistItem('item-one')]) {
  const fixture = await createInitializedTestTicket(repoManager, { title: 'Manual QA route' })
  const clean = captureFinalTestDirtyFiles(fixture.paths.worktreePath)
  insertPhaseArtifact(fixture.ticket.id, {
    phase: 'RUNNING_FINAL_TEST',
    artifactType: 'final_test_file_effects_audit',
    content: JSON.stringify(buildFinalTestFileEffectsAudit({
      baselineDirtyFiles: clean,
      dirtyFilesAfterTesting: clean,
      declaredEffects: [],
    })),
  })
  await prepareManualQaCheckpoint(fixture.ticket.id, 1)
  persistManualQaChecklist(fixture.paths.ticketDir, {
    schemaVersion: 1,
    artifact: 'manual_qa_checklist',
    ticketId: fixture.ticket.externalId,
    version: 1,
    generatedAt: new Date().toISOString(),
    summary: 'Verify the implemented behavior.',
    notApplicablePrdRefs: [],
    items,
  })
  const checklistHash = getManualQaChecklistHash(fixture.paths.ticketDir, 1)!
  patchTicket(fixture.ticket.id, { status: 'WAITING_MANUAL_QA' })
  const draft: ManualQaDraft = {
    schemaVersion: 1,
    artifact: 'manual_qa_draft',
    ticketId: fixture.ticket.externalId,
    version: 1,
    checklistHash,
    draftRevision: 1,
    results: items.map((item) => ({
      itemId: item.id,
      outcome: 'pass',
      note: '',
      observation: '',
      reason: '',
      evidenceIds: [],
      links: [],
    })),
    improvements: [],
    evidence: [],
    updatedAt: new Date().toISOString(),
  }
  insertPhaseArtifact(fixture.ticket.id, {
    phase: 'UI_STATE',
    artifactType: 'ui_state:manual_qa_draft:v1',
    content: JSON.stringify({ revision: 1, data: { results: Object.fromEntries(items.map((item) => [item.id, { status: 'pass' }])) } }),
  })
  const base = `/api/tickets/${encodeURIComponent(fixture.ticket.id)}/manual-qa`
  return { ...fixture, base, checklistHash, draft }
}

function guard(fixture: Awaited<ReturnType<typeof setup>>, actionId: string, version = 1, expectedDraftRevision = 1) {
  return { version, actionId, expectedChecklistHash: fixture.checklistHash, expectedDraftRevision }
}

function uploadHeaders(fixture: Awaited<ReturnType<typeof setup>>, actionId: string, evidenceId: string) {
  return {
    'Content-Type': 'image/png',
    'X-Action-Id': actionId,
    'X-Checklist-Hash': fixture.checklistHash,
    'X-Draft-Revision': '1',
    'X-Evidence-Id': evidenceId,
    'X-File-Name': 'proof.png',
  }
}

function jsonRequest(method: string, body: unknown) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

describe('ticketRouter Manual QA routes', () => {
  beforeEach(() => {
    resetTestDb()
    vi.clearAllMocks()
  })

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('projects checklist versions and reports missing tickets, versions, and invalid version parameters', async () => {
    const fixture = await setup()

    const projection = await app.request(fixture.base)
    expect(projection.status).toBe(200)
    expect(await projection.json()).toMatchObject({ activeVersion: 1, artifactAvailable: true })

    const detail = await app.request(`${fixture.base}/versions/1`)
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({
      version: 1,
      status: 'waiting',
      readOnly: false,
      draftRevision: 1,
      workspaceDrift: { detected: false, decisionRequired: false, files: [] },
      operation: null,
    })

    expect((await app.request('/api/tickets/missing/manual-qa')).status).toBe(404)
    expect((await app.request(`${fixture.base}/versions/2`)).status).toBe(404)
    expect((await app.request(`${fixture.base}/versions/0`)).status).toBe(409)

    patchTicket(fixture.ticket.id, { status: 'GENERATING_QA_CHECKLIST' })
    const generating = await app.request(`${fixture.base}/versions/1`)
    expect(await generating.json()).toMatchObject({ status: 'generating', readOnly: true, workspaceDrift: null })
  })

  it('uploads, retries, serves inline or attached evidence, and completes an idempotent removal', async () => {
    const fixture = await setup()
    const evidenceUrl = `${fixture.base}/versions/1/evidence?itemId=item-one`
    const pngBody = new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer as ArrayBuffer])
    const init = { method: 'PUT', headers: uploadHeaders(fixture, 'upload-one', 'evidence-one'), body: pngBody }

    const uploaded = await app.request(evidenceUrl, init)
    expect(uploaded.status).toBe(201)
    const payload = await uploaded.json() as { evidence: { id: string; inlinePreview: boolean; size: number } }
    expect(payload.evidence).toMatchObject({ id: 'evidence-one', inlinePreview: true, size: 8 })

    const replay = await app.request(evidenceUrl, init)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ evidence: { id: 'evidence-one' }, expectedDraftRevision: 1 })

    const evidencePath = `${fixture.base}/versions/1/evidence/item-one/evidence-one`
    const inline = await app.request(`${evidencePath}?inline=true`)
    expect(inline.status).toBe(200)
    expect(inline.headers.get('Content-Disposition')).toBe('inline; filename="proof.png"')
    expect((await inline.arrayBuffer()).byteLength).toBe(8)
    const attached = await app.request(evidencePath)
    expect(attached.headers.get('Content-Disposition')).toBe('attachment; filename="proof.png"')
    await attached.arrayBuffer()

    const removeBody = guard(fixture, 'remove-one')
    const removed = await app.request(evidencePath, jsonRequest('DELETE', removeBody))
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({ success: true, removed: { id: 'evidence-one' }, expectedDraftRevision: 1 })
    const removeReplay = await app.request(evidencePath, jsonRequest('DELETE', removeBody))
    expect(removeReplay.status).toBe(200)

    const secondUpload = await app.request(evidenceUrl, {
      method: 'PUT',
      headers: {
        ...uploadHeaders(fixture, 'upload-two', 'evidence-two'),
        'Content-Type': 'text/plain',
        'X-File-Name': 'proof.txt',
      },
      body: 'second evidence',
    })
    expect(secondUpload.status).toBe(201)
    const secondEvidence = readManualQaEvidenceIndex(fixture.paths.ticketDir, 1).find((entry) => entry.id === 'evidence-two')!
    persistManualQaEvidenceActionReceipt(fixture.paths.ticketDir, 1, 'remove-staged', 'remove', secondEvidence, 'staged')
    const secondEvidencePath = `${fixture.base}/versions/1/evidence/item-one/evidence-two`
    const stagedRemoveBody = guard(fixture, 'remove-staged')
    const stagedRemove = await app.request(secondEvidencePath, jsonRequest('DELETE', stagedRemoveBody))
    expect(stagedRemove.status).toBe(200)
    expect(await app.request(secondEvidencePath, jsonRequest('DELETE', stagedRemoveBody)).then((response) => response.status)).toBe(200)
    expect(readManualQaEvidenceIndex(fixture.paths.ticketDir, 1)).toEqual([])
  })

  it('recovers an upload whose evidence index committed before its action receipt', async () => {
    const fixture = await setup()
    const bytes = new TextEncoder().encode('saved before receipt')
    await streamManualQaEvidence({
      ticketDir: fixture.paths.ticketDir,
      version: 1,
      itemId: 'item-one',
      evidenceId: 'recovered-file',
      originalName: 'recovery.txt',
      mediaType: 'text/plain',
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }),
    })

    const response = await app.request(`${fixture.base}/versions/1/evidence?itemId=item-one`, {
      method: 'PUT',
      headers: {
        ...uploadHeaders(fixture, 'upload-recovery', 'recovered-file'),
        'Content-Type': 'text/plain',
        'X-File-Name': 'recovery.txt',
      },
      body: 'retry payload is not read',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ evidence: { id: 'recovered-file', originalName: 'recovery.txt' } })

    const mismatch = await app.request(`${fixture.base}/versions/1/evidence?itemId=item-one`, {
      method: 'PUT',
      headers: {
        ...uploadHeaders(fixture, 'upload-mismatch', 'recovered-file'),
        'Content-Type': 'application/octet-stream',
        'X-File-Name': 'recovery.txt',
      },
      body: 'ignored',
    })
    expect(mismatch.status).toBe(400)
  })

  it('rejects missing or stale upload guards and requests made outside the waiting state', async () => {
    const fixture = await setup()
    const evidenceUrl = `${fixture.base}/versions/1/evidence?itemId=item-one`

    const missingGuard = await app.request(evidenceUrl, { method: 'PUT', body: 'x' })
    expect(missingGuard.status).toBe(400)

    const badHash = await app.request(evidenceUrl, {
      method: 'PUT',
      headers: { ...uploadHeaders(fixture, 'upload-bad-hash', 'bad-hash'), 'X-Checklist-Hash': '0'.repeat(64) },
      body: 'x',
    })
    expect(badHash.status).toBe(409)
    expect(await badHash.json()).toMatchObject({ error: 'Manual QA checklist changed; reload before mutating evidence.' })

    const staleRevision = await app.request(evidenceUrl, {
      method: 'PUT',
      headers: { ...uploadHeaders(fixture, 'upload-stale', 'stale'), 'X-Draft-Revision': '0' },
      body: 'x',
    })
    expect(staleRevision.status).toBe(409)
    expect(await staleRevision.json()).toMatchObject({ code: 'MANUAL_QA_DRAFT_CONFLICT', latest: { revision: 1 } })

    patchTicket(fixture.ticket.id, { status: 'CODING' })
    const wrongStatus = await app.request(evidenceUrl, {
      method: 'PUT',
      headers: uploadHeaders(fixture, 'upload-not-waiting', 'not-waiting'),
      body: 'x',
    })
    expect(wrongStatus.status).toBe(409)
  })

  it('submits canonical drafts, rejects invalid fallback drafts, and skips from the saved UI draft', async () => {
    const fixture = await setup([checklistItem('item-one'), checklistItem('item-two')])
    const invalidMerge = await app.request(`${fixture.base}/submit`, jsonRequest('POST', {
      ...guard(fixture, 'submit-invalid-merge'),
      draft: { results: {
        'item-one': { status: 'fail', observation: 'The behavior failed.', mergeWithItemIds: ['item-two'] },
        'item-two': { status: 'pass' },
      } },
    }))
    expect(invalidMerge.status).toBe(400)
    expect(await invalidMerge.json()).toMatchObject({ error: expect.stringContaining('not marked as Fail') })

    const submit = await app.request(`${fixture.base}/submit`, jsonRequest('POST', {
      ...guard(fixture, 'submit-valid'),
      draft: fixture.draft,
    }))
    expect(submit.status).toBe(200)
    expect(await submit.json()).toMatchObject({ version: 1, status: 'passed', readOnly: true, summary: { outcome: 'passed' } })
    expect(ensureActorForTicket).toHaveBeenCalledWith(fixture.ticket.id)
    expect(sendTicketEvent).toHaveBeenCalledWith(fixture.ticket.id, { type: 'MANUAL_QA_COMPLETE' })

    const completed = await app.request(`${fixture.base}/versions/1`)
    expect(await completed.json()).toMatchObject({ status: 'completed', readOnly: true })

    const skippedFixture = await setup()
    const skip = await app.request(`${skippedFixture.base}/skip`, jsonRequest('POST', {
      ...guard(skippedFixture, 'skip-valid'),
      // No request draft: the route canonicalizes the last saved UI draft.
    }))
    expect(skip.status).toBe(200)
    expect(await skip.json()).toMatchObject({ version: 1, status: 'skipped', readOnly: true, summary: { outcome: 'skipped' } })
    expect(sendTicketEvent).toHaveBeenCalledWith(skippedFixture.ticket.id, { type: 'MANUAL_QA_SKIPPED' })
  })

  it('includes and discards the current workspace drift through their routed decisions', async () => {
    const fixture = await setup()
    const includePath = 'manual-qa-include.txt'
    writeFileSync(resolve(fixture.paths.worktreePath, includePath), 'include this change')
    const include = await app.request(`${fixture.base}/workspace-drift/include`, jsonRequest('POST', guard(fixture, 'drift-include')))
    expect(include.status).toBe(200)
    expect(await include.json()).toMatchObject({ status: 'waiting', workspaceDrift: { detected: false, files: [] }, operation: { status: 'drift_resolved', receipt: { decision: 'include', files: [includePath] } } })

    const discardPath = 'manual-qa-discard.txt'
    writeFileSync(resolve(fixture.paths.worktreePath, discardPath), 'discard this change')
    const discard = await app.request(`${fixture.base}/workspace-drift/discard`, jsonRequest('POST', {
      ...guard(fixture, 'drift-discard'),
      files: [discardPath],
    }))
    expect(discard.status).toBe(200)
    expect(await discard.json()).toMatchObject({ operation: { status: 'drift_resolved', receipt: { decision: 'discard', files: [discardPath] } } })
  })

  it('preserves Manual QA error status for missing checklist and revision conflicts', async () => {
    const fixture = await setup()
    const missingChecklist = await app.request(`${fixture.base}/submit`, jsonRequest('POST', {
      ...guard(fixture, 'submit-missing-checklist', 2, 0),
      draft: { results: {} },
    }))
    expect(missingChecklist.status).toBe(404)
    expect(await missingChecklist.json()).toMatchObject({ error: 'Manual QA checklist v2 was not found.' })

    const malformedBody = await app.request(`${fixture.base}/submit`, jsonRequest('POST', {
      ...guard(fixture, 'submit-invalid-action'),
      actionId: 'invalid action id',
    }))
    expect(malformedBody.status).toBe(400)
  })
})
