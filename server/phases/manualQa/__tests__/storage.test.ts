import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTempDir } from '../../../test/tempDir'
import {
  MAX_MANUAL_QA_EVIDENCE_BYTES,
  ManualQaEvidenceLinkSchema,
} from '../types'
import {
  completeManualQaReservation,
  appendManualQaEvent,
  getManualQaStoragePaths,
  getManualQaEvidenceRelativePath,
  isSafeRasterMediaType,
  persistManualQaChecklist,
  persistManualQaModelCapabilitySnapshot,
  persistManualQaResults,
  persistManualQaSummary,
  persistManualQaEvidenceActionReceipt,
  readManualQaEvidenceActionReceipt,
  readManualQaEvidenceIndex,
  readManualQaEvents,
  readManualQaModelCapabilitySnapshot,
  readManualQaResults,
  removeManualQaEvidence,
  reserveManualQaVersion,
  resolveActiveManualQaVersion,
  resolveManualQaEvidence,
  sanitizeEvidenceName,
  streamManualQaEvidence,
} from '../storage'
import { buildImprovementDescription } from '../operations'
import { reserveManualQaSubmissionOperation } from '../operations'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root() {
  const value = makeTempDir('looptroop-manual-qa-')
  roots.push(value)
  return value
}

function byteStream(value: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(value)
      controller.close()
    },
  })
}

function persistChecklist(ticketDir: string) {
  persistManualQaChecklist(ticketDir, {
    schemaVersion: 1,
    artifact: 'manual_qa_checklist',
    ticketId: 'DEMO-1',
    version: 1,
    generatedAt: new Date().toISOString(),
    summary: 'Verify the application behavior.',
    notApplicablePrdRefs: [],
    items: [{
      id: 'qa-v1-001',
      lineageId: 'lineage-001',
      title: 'Application usability',
      priorItemIds: [],
      source: 'implementation_diff',
      behavior: 'The application remains usable.',
      severity: 'required',
      recheckState: 'new',
      prerequisites: [],
      actions: ['Exercise the behavior.'],
      expectedResult: 'The behavior works.',
      watchNotes: [],
      beadRefs: [],
      prdRefs: [],
    }],
  })
}

describe('Manual QA canonical storage', () => {
  it('reuses a durable generation reservation after restart', () => {
    const ticketDir = root()
    const first = reserveManualQaVersion(ticketDir, '1:DEMO-1', 1, 'generation:one')
    const restored = reserveManualQaVersion(ticketDir, '1:DEMO-1', 1, 'generation:two')
    expect(restored).toEqual(first)
    completeManualQaReservation(ticketDir, first, 'a'.repeat(64))
    expect(JSON.parse(readFileSync(getManualQaStoragePaths(ticketDir, 1).reservationPath, 'utf8'))).toMatchObject({
      state: 'complete',
      checklistHash: 'a'.repeat(64),
    })
  })

  it('has no active version after every historical round is complete', () => {
    const ticketDir = root()
    persistChecklist(ticketDir)
    expect(resolveActiveManualQaVersion(ticketDir)).toBe(1)
    persistManualQaSummary(ticketDir, {
      schemaVersion: 1,
      artifact: 'manual_qa_summary',
      ticketId: 'DEMO-1',
      version: 1,
      outcome: 'passed',
      createdFixBeadIds: [],
      improvementTicketIds: [],
      waivedItemIds: [],
      waivedItems: [],
      startedAt: '2026-07-13T00:00:00.000Z',
      completedAt: '2026-07-13T00:01:00.000Z',
      durationMs: 60_000,
      itemCounts: { pass: 1, fail: 0, waive: 0, improvement: 0, pending: 0 },
      requiredItemCount: 1,
      optionalItemCount: 0,
      evidenceCount: 0,
      nextAction: 'integrate',
      coverage: { covered: 0, partiallyCovered: 0, uncovered: 0, notApplicable: 0 },
      modelCapability: null,
    })
    expect(resolveActiveManualQaVersion(ticketDir)).toBeNull()
  })

  it('keeps an intermediate failed summary active until fix creation completes', () => {
    const ticketDir = root()
    persistChecklist(ticketDir)
    persistManualQaSummary(ticketDir, {
      schemaVersion: 1,
      artifact: 'manual_qa_summary',
      ticketId: 'DEMO-1',
      version: 1,
      outcome: 'failed',
      createdFixBeadIds: [],
      improvementTicketIds: [],
      waivedItemIds: [],
      waivedItems: [],
      startedAt: '2026-07-13T00:00:00.000Z',
      completedAt: '2026-07-13T00:01:00.000Z',
      durationMs: 60_000,
      itemCounts: { pass: 0, fail: 1, waive: 0, improvement: 0, pending: 0 },
      requiredItemCount: 1,
      optionalItemCount: 0,
      evidenceCount: 0,
      nextAction: 'return_to_coding',
      coverage: { covered: 0, partiallyCovered: 0, uncovered: 0, notApplicable: 0 },
      modelCapability: null,
    })

    expect(resolveActiveManualQaVersion(ticketDir)).toBe(1)
  })

  it('round-trips application-owned YAML without treating colon-bearing action IDs as mappings', () => {
    const ticketDir = root()
    persistChecklist(ticketDir)
    persistManualQaResults(ticketDir, {
      schemaVersion: 1,
      artifact: 'manual_qa_results',
      ticketId: 'DEMO-1',
      version: 1,
      checklistHash: 'a'.repeat(64),
      draftRevision: 1,
      results: [{
        itemId: 'qa-v1-001',
        outcome: 'fail',
        note: '',
        observation: 'The border remained unchanged.',
        reason: '',
        evidenceIds: [],
        links: [],
      }],
      improvements: [],
      evidence: [],
      updatedAt: '2026-07-13T00:00:00.000Z',
      actionId: 'manual-qa-submit:817fd50e-4f77-4b6d-bc09-18c9c4d89328',
      submittedAt: '2026-07-13T00:01:00.000Z',
    })

    expect(readManualQaResults(ticketDir, 1)?.actionId)
      .toBe('manual-qa-submit:817fd50e-4f77-4b6d-bc09-18c9c4d89328')
  })

  it('streams evidence into an item-contained directory and makes action retries idempotent', async () => {
    const ticketDir = root()
    persistChecklist(ticketDir)
    const evidence = await streamManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: 'qa-v1-001',
      evidenceId: 'evidence:one',
      originalName: '../../screen.png',
      mediaType: 'image/png',
      body: byteStream(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])),
    })
    expect(evidence.originalName).toBe('screen.png')
    expect(evidence.storedName).toMatch(/^item-qa-v1-001\//)
    expect(evidence.inlinePreview).toBe(true)
    expect(resolveManualQaEvidence({ ticketDir, version: 1, itemId: 'qa-v1-001', evidenceId: evidence.id }).path)
      .toContain('/manual-qa/v1/evidence/item-qa-v1-001/')
    expect(getManualQaEvidenceRelativePath(1, evidence)).toBe(`manual-qa/v1/evidence/${evidence.storedName}`)

    const receipt = persistManualQaEvidenceActionReceipt(ticketDir, 1, 'upload:one', 'upload', evidence)
    expect(persistManualQaEvidenceActionReceipt(ticketDir, 1, 'upload:one', 'upload', evidence)).toEqual(receipt)
    expect(readManualQaEvidenceActionReceipt(ticketDir, 1, 'upload:one')?.evidence.id).toBe(evidence.id)
  })

  it('repairs an upload interrupted after file rename but before index persistence', async () => {
    const ticketDir = root()
    persistChecklist(ticketDir)
    const bytes = new TextEncoder().encode('durable evidence')
    const first = await streamManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: 'qa-v1-001',
      evidenceId: 'interrupted-upload',
      originalName: 'trace.txt',
      mediaType: 'text/plain',
      body: byteStream(bytes),
    })
    writeFileSync(getManualQaStoragePaths(ticketDir, 1).evidenceIndexPath, '[]')

    const recovered = await streamManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: 'qa-v1-001',
      evidenceId: 'interrupted-upload',
      originalName: 'trace.txt',
      mediaType: 'text/plain',
      body: byteStream(bytes),
    })

    expect(recovered).toMatchObject({ id: first.id, sha256: first.sha256, size: first.size })
    expect(resolveManualQaEvidence({ ticketDir, version: 1, itemId: 'qa-v1-001', evidenceId: first.id }).metadata.sha256).toBe(first.sha256)
  })

  it('supports staged removal receipts across an interrupted delete', async () => {
    const ticketDir = root()
    persistChecklist(ticketDir)
    const evidence = await streamManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: 'qa-v1-001',
      evidenceId: 'remove-after-restart',
      originalName: 'trace.txt',
      mediaType: 'text/plain',
      body: byteStream(new TextEncoder().encode('remove me')),
    })
    expect(persistManualQaEvidenceActionReceipt(ticketDir, 1, 'remove:restart', 'remove', evidence, 'staged').state).toBe('staged')
    removeManualQaEvidence({ ticketDir, version: 1, itemId: evidence.itemId, evidenceId: evidence.id })
    expect(persistManualQaEvidenceActionReceipt(ticketDir, 1, 'remove:restart', 'remove', evidence, 'complete').state).toBe('complete')
    expect(() => resolveManualQaEvidence({ ticketDir, version: 1, itemId: evidence.itemId, evidenceId: evidence.id })).toThrow('not found')
  })

  it('repairs a staged removal interrupted after unlink but before index persistence', async () => {
    const ticketDir = root()
    persistChecklist(ticketDir)
    const evidence = await streamManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: 'qa-v1-001',
      evidenceId: 'remove-after-unlink',
      originalName: 'trace.txt',
      mediaType: 'text/plain',
      body: byteStream(new TextEncoder().encode('remove me')),
    })
    persistManualQaEvidenceActionReceipt(ticketDir, 1, 'remove:after-unlink', 'remove', evidence, 'staged')
    const storedPath = resolveManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: evidence.itemId,
      evidenceId: evidence.id,
    }).path
    rmSync(dirname(storedPath), { recursive: true, force: true })

    expect(removeManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: evidence.itemId,
      evidenceId: evidence.id,
      evidence,
    })).toEqual(evidence)
    expect(readManualQaEvidenceIndex(ticketDir, 1)).toEqual([])
  })

  it('allows a new removal action to finish after reload when only index metadata remains', async () => {
    const ticketDir = root()
    persistChecklist(ticketDir)
    const evidence = await streamManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: 'qa-v1-001',
      evidenceId: 'remove-new-action-after-unlink',
      originalName: 'trace.txt',
      mediaType: 'text/plain',
      body: byteStream(new TextEncoder().encode('remove me')),
    })
    rmSync(resolveManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: evidence.itemId,
      evidenceId: evidence.id,
    }).path)
    const canonical = readManualQaEvidenceIndex(ticketDir, 1)
      .find((entry) => entry.id === evidence.id && entry.itemId === evidence.itemId)!

    persistManualQaEvidenceActionReceipt(ticketDir, 1, 'remove:new-after-reload', 'remove', canonical, 'staged')
    removeManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: canonical.itemId,
      evidenceId: canonical.id,
      evidence: canonical,
    })
    expect(persistManualQaEvidenceActionReceipt(
      ticketDir,
      1,
      'remove:new-after-reload',
      'remove',
      canonical,
      'complete',
    ).state).toBe('complete')
    expect(readManualQaEvidenceIndex(ticketDir, 1)).toEqual([])
  })

  it('preserves both index entries when evidence uploads finish concurrently', async () => {
    const ticketDir = root()
    persistChecklist(ticketDir)
    let releaseFirst!: () => void
    let markFirstPull!: () => void
    const firstPulled = new Promise<void>((resolve) => { markFirstPull = resolve })
    const release = new Promise<void>((resolve) => { releaseFirst = resolve })
    let pulled = false
    const delayedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (pulled) return
        pulled = true
        controller.enqueue(new TextEncoder().encode('first'))
        markFirstPull()
        await release
        controller.close()
      },
    }, { highWaterMark: 0 })
    const firstUpload = streamManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: 'qa-v1-001',
      evidenceId: 'concurrent-first',
      originalName: 'first.txt',
      mediaType: 'text/plain',
      body: delayedBody,
    })
    await firstPulled
    await streamManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: 'qa-v1-001',
      evidenceId: 'concurrent-second',
      originalName: 'second.txt',
      mediaType: 'text/plain',
      body: byteStream(new TextEncoder().encode('second')),
    })
    releaseFirst()
    await firstUpload

    expect(readManualQaEvidenceIndex(ticketDir, 1).map((entry) => entry.id).sort())
      .toEqual(['concurrent-first', 'concurrent-second'])
  })

  it('rejects evidence reads through a symlinked item directory', async () => {
    const ticketDir = root()
    const outside = root()
    persistChecklist(ticketDir)
    const evidence = await streamManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: 'qa-v1-001',
      evidenceId: 'symlink-parent',
      originalName: 'trace.txt',
      mediaType: 'text/plain',
      body: byteStream(new TextEncoder().encode('inside')),
    })
    const storedPath = resolveManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: evidence.itemId,
      evidenceId: evidence.id,
    }).path
    const itemDir = dirname(storedPath)
    rmSync(itemDir, { recursive: true, force: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, basename(storedPath)), 'outside')
    symlinkSync(outside, itemDir, 'dir')

    expect(() => resolveManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: evidence.itemId,
      evidenceId: evidence.id,
    })).toThrow('unsafe directory')
  })

  it('rejects evidence reads when the version directory is replaced by a symlink', async () => {
    const ticketDir = root()
    const outside = root()
    persistChecklist(ticketDir)
    const evidence = await streamManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: 'qa-v1-001',
      evidenceId: 'symlink-version',
      originalName: 'trace.txt',
      mediaType: 'text/plain',
      body: byteStream(new TextEncoder().encode('inside')),
    })
    const versionDir = getManualQaStoragePaths(ticketDir, 1).versionDir
    cpSync(versionDir, outside, { recursive: true })
    rmSync(versionDir, { recursive: true, force: true })
    symlinkSync(outside, versionDir, 'dir')

    expect(() => resolveManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: evidence.itemId,
      evidenceId: evidence.id,
    })).toThrow('unsafe directory')
  })

  it('rejects a symlinked version before upload creates directories outside storage', async () => {
    const ticketDir = root()
    const outside = root()
    persistChecklist(ticketDir)
    const versionDir = getManualQaStoragePaths(ticketDir, 1).versionDir
    cpSync(versionDir, outside, { recursive: true })
    rmSync(versionDir, { recursive: true, force: true })
    symlinkSync(outside, versionDir, 'dir')

    await expect(streamManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: 'qa-v1-001',
      evidenceId: 'blocked-symlink-upload',
      originalName: 'trace.txt',
      mediaType: 'text/plain',
      body: byteStream(new TextEncoder().encode('outside write must not happen')),
    })).rejects.toThrow('unsafe directory')
    expect(existsSync(join(outside, 'evidence'))).toBe(false)
  })

  it('binds evidence to real checklist items and verifies preview file signatures', async () => {
    const ticketDir = root()
    persistChecklist(ticketDir)
    await expect(streamManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: 'unknown-item',
      evidenceId: 'unknown-evidence',
      originalName: 'unknown.png',
      mediaType: 'image/png',
      body: byteStream(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])),
    })).rejects.toThrow('unknown checklist item')

    const spoofed = await streamManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: 'qa-v1-001',
      evidenceId: 'spoofed-image',
      originalName: 'spoofed.png',
      mediaType: 'image/png',
      body: byteStream(new TextEncoder().encode('<html>not an image</html>')),
    })
    expect(spoofed.inlinePreview).toBe(false)
  })

  it('uses collision-safe action receipts and rejects action reuse for different evidence', async () => {
    const ticketDir = root()
    persistChecklist(ticketDir)
    const first = await streamManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: 'qa-v1-001',
      evidenceId: 'first',
      originalName: 'first.txt',
      mediaType: 'text/plain',
      body: byteStream(new TextEncoder().encode('first')),
    })
    const second = await streamManualQaEvidence({
      ticketDir,
      version: 1,
      itemId: 'qa-v1-001',
      evidenceId: 'second',
      originalName: 'second.txt',
      mediaType: 'text/plain',
      body: byteStream(new TextEncoder().encode('second')),
    })
    persistManualQaEvidenceActionReceipt(ticketDir, 1, 'upload:one', 'upload', first)
    persistManualQaEvidenceActionReceipt(ticketDir, 1, 'upload_one', 'upload', second)
    expect(readManualQaEvidenceActionReceipt(ticketDir, 1, 'upload:one')?.evidence.id).toBe('first')
    expect(readManualQaEvidenceActionReceipt(ticketDir, 1, 'upload_one')?.evidence.id).toBe('second')
    expect(() => persistManualQaEvidenceActionReceipt(ticketDir, 1, 'upload:one', 'upload', second))
      .toThrow('another operation or evidence item')
  })

  it('enforces the evidence safety contract and link protocols', () => {
    expect(MAX_MANUAL_QA_EVIDENCE_BYTES).toBe(250 * 1024 * 1024)
    expect(sanitizeEvidenceName('..\\..\\evil\u0000.exe')).toBe('evil.exe')
    // Windows rejects these outright; ':' is the NTFS stream separator.
    expect(sanitizeEvidenceName('evidence:one.png')).toBe('evidence_one.png')
    expect(sanitizeEvidenceName('a<b>c:d"e|f?g*h.png')).toBe('a_b_c_d_e_f_g_h.png')
    expect(isSafeRasterMediaType('image/webp')).toBe(true)
    expect(isSafeRasterMediaType('image/svg+xml')).toBe(false)
    expect(ManualQaEvidenceLinkSchema.safeParse({ id: 'link:1', url: 'https://example.com/evidence' }).success).toBe(true)
    expect(ManualQaEvidenceLinkSchema.safeParse({ id: 'link:1', url: 'file:///tmp/evidence' }).success).toBe(false)
    expect(ManualQaEvidenceLinkSchema.safeParse({ id: 'link:1', url: 'javascript:alert(1)' }).success).toBe(false)
  })

  it('preserves the user-edited description before generated Manual QA context', () => {
    const result = buildImprovementDescription({
      description: 'A'.repeat(12_000),
      sourceExternalId: 'DEMO-1',
      version: 3,
      itemId: 'qa-v3-002',
      behavior: 'The filter should preserve selection',
      source: 'implementation_diff',
      expectedResult: 'Selection remains after reload',
      actions: ['Choose a filter', 'Reload'],
      improvementTitle: 'Remember the selected filter',
      userNote: 'This would reduce repetitive setup.',
      evidence: [],
      links: [{ url: 'https://example.com/note', label: 'Reference' }],
      prdRefs: ['EPIC-1/US-1/AC-1 (partial)'],
      beadRefs: ['DEMO-1.2'],
    })
    expect(result.description.length).toBeLessThanOrEqual(10_000)
    expect(result.description).toBe('A'.repeat(10_000))
    expect(result.omittedFields).toContain('userEditedDescription')
    expect(result.omittedFields).toContain('manualQaContext')
    expect(result.omittedFields).toContain('prdIdsMetadataOnly')
    expect(result.omittedFields).toContain('beadIdsMetadataOnly')
  })

  it('keeps structured identifiers out of the context-bearing improvement description', () => {
    const result = buildImprovementDescription({
      description: 'Remember the selection for the next visit.',
      title: 'Persist filter selection',
      sourceExternalId: 'DEMO-1',
      version: 3,
      itemId: 'qa-v3-002',
      behavior: 'The filter should preserve selection',
      source: 'implementation_diff',
      expectedResult: 'Selection remains after reload',
      actions: ['Choose a filter', 'Reload'],
      improvementTitle: 'Remember the selected filter',
      userNote: 'This would reduce repetitive setup.',
      evidence: [],
      prdRefs: ['EPIC-1/US-1/AC-1'],
      beadRefs: ['DEMO-1.2'],
      prdRequirements: ['The selected filter remains active after reload.'],
      beadWorkAreas: ['Persist filter state — Store and restore the selection.'],
      evidenceSummary: '2 uploaded files (1 image and 1 other file) retained with the Manual QA origin metadata.',
    })
    expect(result.description).toContain('## Manual QA Context')
    expect(result.description).toContain('This follow-up was created from a non-blocking Manual QA improvement.')
    expect(result.description).toContain('- Title: Persist filter selection')
    expect(result.description).not.toContain('DEMO-1')
    expect(result.description).not.toContain('qa-v3-002')
    expect(result.description).not.toContain('EPIC-1/US-1/AC-1')
    expect(result.description).toContain('PRD requirement: The selected filter remains active after reload.')
    expect(result.description).toContain('Implementation work area: Persist filter state')
    expect(result.description).toContain('Evidence summary: 2 uploaded files')
  })

  it('honors a reviewed Manual QA context override', () => {
    const result = buildImprovementDescription({
      description: 'Keep the editable lead description.',
      contextOverride: '## Reviewed QA Context\nUse this reviewed implementation context.',
      sourceExternalId: 'DEMO-1',
      version: 1,
      itemId: 'qa-v1-001',
      behavior: 'Default generated behavior',
      expectedResult: 'Default generated expectation',
      evidence: [],
    })
    expect(result.description).toBe('Keep the editable lead description.\n## Reviewed QA Context\nUse this reviewed implementation context.')
    expect(result.description).not.toContain('Default generated behavior')
  })

  it('persists an immutable capability snapshot and append-only idempotent events', () => {
    const ticketDir = root()
    const snapshot = {
      schemaVersion: 1 as const,
      artifact: 'manual_qa_model_capability' as const,
      ticketId: 'DEMO-1',
      version: 1,
      modelId: 'provider/model',
      modelVariant: 'high',
      capabilityLookup: 'available' as const,
      supportsImages: true,
      imageEvidenceMode: 'attached' as const,
      capturedAt: '2026-07-13T00:00:00.000Z',
    }
    persistManualQaModelCapabilitySnapshot(ticketDir, snapshot)
    persistManualQaModelCapabilitySnapshot(ticketDir, snapshot)
    expect(readManualQaModelCapabilitySnapshot(ticketDir, 1)).toEqual(snapshot)

    const event = {
      schemaVersion: 1 as const,
      eventId: 'checklist-v1-ready',
      eventType: 'checklist_ready' as const,
      ticketId: 'DEMO-1',
      version: 1,
      actionId: 'generation-one',
      createdAt: '2026-07-13T00:00:00.000Z',
      data: { checklistHash: 'a'.repeat(64) },
    }
    appendManualQaEvent(ticketDir, event)
    appendManualQaEvent(ticketDir, event)
    expect(readManualQaEvents(ticketDir)).toEqual([event])
  })

  it('reuses submission operations by action ID and rejects conflicting retries', () => {
    const path = join(root(), 'manual-qa', 'v1', 'submission-operation.json')
    const first = reserveManualQaSubmissionOperation({
      path,
      actionId: 'submit:one',
      operationType: 'submit',
      ticketId: '1:DEMO-1',
      version: 1,
      checklistHash: 'a'.repeat(64),
      draftRevision: 4,
    })
    expect(reserveManualQaSubmissionOperation({
      path,
      actionId: 'submit:one',
      operationType: 'submit',
      ticketId: '1:DEMO-1',
      version: 1,
      checklistHash: 'a'.repeat(64),
      draftRevision: 4,
    })).toEqual(first)
    expect(() => reserveManualQaSubmissionOperation({
      path,
      actionId: 'submit:one',
      operationType: 'submit',
      ticketId: '1:DEMO-1',
      version: 1,
      checklistHash: 'b'.repeat(64),
      draftRevision: 4,
    })).toThrow('different input')
    expect(() => reserveManualQaSubmissionOperation({
      path,
      actionId: 'submit:one',
      operationType: 'skip',
      ticketId: '1:DEMO-1',
      version: 1,
      checklistHash: 'a'.repeat(64),
      draftRevision: 4,
    })).toThrow('different input')
  })
})
