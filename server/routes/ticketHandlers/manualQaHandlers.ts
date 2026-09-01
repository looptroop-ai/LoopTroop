import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import type { Context } from 'hono'
import { ensureActorForTicket, sendTicketEvent } from '../../machines/persistence'
import { getTicketByRef, getTicketPaths } from '../../storage/tickets'
import {
  MAX_MANUAL_QA_EVIDENCE_BYTES,
  appendManualQaEvent,
  ManualQaDraftSchema,
  buildManualQaProjection,
  detectManualQaWorkspaceDrift,
  discardManualQaWorkspaceDrift,
  getManualQaChecklistHash,
  getManualQaVersionDetail,
  includeManualQaWorkspaceDrift,
  isSafeRasterMediaType,
  removeManualQaEvidence,
  resolveManualQaEvidence,
  streamManualQaEvidence,
  submitManualQa,
  skipManualQa,
  readManualQaEvidenceIndex,
  readManualQaChecklist,
  getManualQaStoragePaths,
  readManualQaEvidenceActionReceipt,
  persistManualQaEvidenceActionReceipt,
  sanitizeEvidenceName,
} from '../../phases/manualQa'
import { readTicketUiState } from './uiStateHandlers'
import { getRequiredRouteParam, getTicketParam } from './routeUtils'
import { createManualQaImprovementDraftId } from '../../../shared/manualQaImprovement'
import { buildManualQaMergeGroupIds } from '../../../shared/manualQaMergeGroups'
import { getErrorMessage } from '@shared/typeGuards'

function parseVersion(c: Context): number {
  const version = Number(getRequiredRouteParam(c, 'version'))
  if (!Number.isInteger(version) || version < 1) throw new Error('Manual QA version must be a positive integer.')
  return version
}

type RequiredTicket = {
  ticketId: string
  ticket: NonNullable<ReturnType<typeof getTicketByRef>>
  paths: NonNullable<ReturnType<typeof getTicketPaths>>
}

function requireTicket(c: Context): RequiredTicket | null {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  const paths = getTicketPaths(ticketId)
  if (!ticket || !paths) return null
  return { ticketId, ticket, paths }
}

function readManualQaDraftState(ticketId: string, version: number) {
  return readTicketUiState(ticketId, `manual_qa_draft:v${version}`)
}

function assertServerDraftRevision(ticketId: string, version: number, expectedRevision: number) {
  const latest = readManualQaDraftState(ticketId, version)
  const revision = latest?.revision ?? 0
  if (revision !== expectedRevision) {
    const error = new Error('Manual QA draft revision conflict; reload the latest state.')
    Object.assign(error, { code: 'MANUAL_QA_DRAFT_CONFLICT', latest: latest ?? { data: null, revision: 0 } })
    throw error
  }
  return latest
}

function toCanonicalDraft(input: {
  raw: unknown
  ticketExternalId: string
  ticketDir: string
  version: number
  checklistHash: string
  revision: number
  validateMergeGroups?: boolean
}) {
  const direct = ManualQaDraftSchema.safeParse(input.raw)
  if (direct.success) return direct.data
  const raw = input.raw && typeof input.raw === 'object' && !Array.isArray(input.raw) ? input.raw as Record<string, unknown> : {}
  const resultRecord = raw.results && typeof raw.results === 'object' && !Array.isArray(raw.results)
    ? raw.results as Record<string, unknown>
    : {}
  const improvements: Array<{
    id: string
    itemId: string
    title: string
    description: string
    contextOverride?: string
    evidenceIds: string[]
    priority: number
    manualQaEnabled: boolean
  }> = []
  const rawResults = Object.entries(resultRecord).map(([itemId, rawValue]) => {
    const value = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? rawValue as Record<string, unknown> : {}
    const improvement = value.improvement && typeof value.improvement === 'object' && !Array.isArray(value.improvement)
      ? value.improvement as Record<string, unknown>
      : null
    const improvementDraftId = improvement ? createManualQaImprovementDraftId(input.version, itemId) : undefined
    if (improvement && improvementDraftId) {
      if (typeof improvement.manualQaEnabled !== 'boolean') {
        throw new Error(`Improvement ${improvementDraftId} must explicitly enable or disable Manual QA.`)
      }
      improvements.push({
        id: improvementDraftId,
        itemId,
        title: String(improvement.title ?? '').trim(),
        description: String(improvement.description ?? '').trim(),
        ...(typeof improvement.contextOverride === 'string' && improvement.contextOverride.trim()
          ? { contextOverride: improvement.contextOverride.trim() }
          : {}),
        evidenceIds: Array.isArray(improvement.evidenceIds) ? improvement.evidenceIds.map(String) : [],
        priority: Number(improvement.priority),
        manualQaEnabled: improvement.manualQaEnabled,
      })
    }
    return {
      itemId,
      outcome: String(value.status ?? value.outcome ?? 'pending'),
      note: String(value.note ?? ''),
      observation: String(value.observation ?? ''),
      reason: String(value.waiverReason ?? value.reason ?? ''),
      evidenceIds: Array.isArray(value.evidenceIds) ? value.evidenceIds.map(String) : [],
      links: Array.isArray(value.links) ? value.links : [],
      ...(improvementDraftId ? { improvementDraftId } : {}),
      mergeWithItemIds: Array.isArray(value.mergeWithItemIds) ? value.mergeWithItemIds.map(String) : [],
    }
  })
  const mergeGroupIds = buildManualQaMergeGroupIds(rawResults.map((result) => ({
    itemId: result.itemId,
    status: result.outcome,
    mergeWithItemIds: result.mergeWithItemIds,
  })))
  if (input.validateMergeGroups) {
    const checklist = readManualQaChecklist(input.ticketDir, input.version)
    if (!checklist) throw new Error(`Manual QA checklist v${input.version} was not found.`)
    const itemIndex = new Map(checklist.items.map((item, index) => [item.id, { item, index }]))
    const resultById = new Map(rawResults.map((result) => [result.itemId, result]))
    for (const result of rawResults) {
      if (result.outcome !== 'fail') continue
      const source = itemIndex.get(result.itemId)
      const invalid = [...new Set(result.mergeWithItemIds)]
        .map((itemId) => itemIndex.get(itemId))
        .filter((entry) => !entry || resultById.get(entry.item.id)?.outcome !== 'fail')
      if (invalid.length === 0) continue
      const labels = invalid.map((entry) => entry
        ? `item ${entry.index + 1} ${entry.item.title}`
        : 'an unknown item')
      const joined = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
      throw new Error(`Item ${(source?.index ?? -1) + 1} ${source?.item.title ?? result.itemId} has ${joined} in its merge group, but ${invalid.length === 1 ? 'that item was' : 'those items were'} not marked as Fail.`)
    }
  }
  const results = rawResults.map(({ mergeWithItemIds: _mergeWithItemIds, ...result }) => ({
    ...result,
    ...(mergeGroupIds.get(result.itemId) ? { mergeGroupId: mergeGroupIds.get(result.itemId) } : {}),
  }))
  return ManualQaDraftSchema.parse({
    schemaVersion: 1,
    artifact: 'manual_qa_draft',
    ticketId: input.ticketExternalId,
    version: input.version,
    checklistHash: input.checklistHash,
    draftRevision: input.revision,
    results,
    improvements,
    evidence: readManualQaEvidenceIndex(input.ticketDir, input.version),
    updatedAt: new Date().toISOString(),
  })
}

function requireWaitingStatus(c: Context, ticket: { status: string }) {
  return ticket.status === 'WAITING_MANUAL_QA'
    ? null
    : c.json({ error: 'Manual QA mutations are only available while waiting for Manual QA.' }, 409)
}

function parseMutationHeaders(c: Context) {
  const actionId = c.req.header('X-Action-Id')?.trim() ?? c.req.query('actionId')?.trim() ?? ''
  const expectedChecklistHash = c.req.header('X-Checklist-Hash')?.trim() ?? c.req.query('expectedChecklistHash')?.trim() ?? ''
  const revisionRaw = c.req.header('X-Draft-Revision') ?? c.req.query('expectedDraftRevision')
  const expectedDraftRevision = Number(revisionRaw)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(actionId)) throw new Error('A valid action ID is required.')
  if (!/^[a-f0-9]{64}$/.test(expectedChecklistHash)) throw new Error('A valid expected checklist hash is required.')
  if (!Number.isInteger(expectedDraftRevision) || expectedDraftRevision < 0) throw new Error('A valid expected draft revision is required.')
  return { actionId, expectedChecklistHash, expectedDraftRevision }
}

function parseMutationBody(body: Record<string, unknown>) {
  const actionId = String(body.actionId ?? '')
  const expectedChecklistHash = String(body.expectedChecklistHash ?? '')
  const expectedDraftRevision = Number(body.expectedDraftRevision)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(actionId)) throw new Error('A valid action ID is required.')
  if (!/^[a-f0-9]{64}$/.test(expectedChecklistHash)) throw new Error('A valid expected checklist hash is required.')
  if (!Number.isInteger(expectedDraftRevision) || expectedDraftRevision < 0) throw new Error('A valid expected draft revision is required.')
  return { actionId, expectedChecklistHash, expectedDraftRevision }
}

function assertChecklistHash(ticketDir: string, version: number, expected: string): void {
  if (getManualQaChecklistHash(ticketDir, version) !== expected) {
    throw new Error('Manual QA checklist changed; reload before mutating evidence.')
  }
}

function appendEvidenceEvent(input: {
  ticketDir: string
  ticketExternalId: string
  version: number
  actionId: string
  operation: 'upload' | 'remove'
  itemId: string
  evidenceId: string
  createdAt: string
}): void {
  const eventType = input.operation === 'upload' ? 'evidence_uploaded' : 'evidence_removed'
  appendManualQaEvent(input.ticketDir, {
    schemaVersion: 1,
    eventId: `evidence-${input.operation === 'upload' ? 'uploaded' : 'removed'}-${createHash('sha256').update(input.actionId).digest('hex').slice(0, 24)}`,
    eventType,
    ticketId: input.ticketExternalId,
    version: input.version,
    actionId: input.actionId,
    createdAt: input.createdAt,
    data: { itemId: input.itemId, evidenceId: input.evidenceId },
  })
}

function manualQaError(c: Context, error: unknown) {
  const message = getErrorMessage(error)
  const drift = error && typeof error === 'object' && 'drift' in error ? (error as { drift: unknown }).drift : undefined
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined
  if (code === 'MANUAL_QA_DRAFT_CONFLICT') {
    return c.json({ error: message, code, latest: (error as { latest?: unknown }).latest }, 409)
  }
  if (code === 'MANUAL_QA_WORKSPACE_DRIFT') return c.json({ error: message, code, drift }, 409)
  if (/not found/i.test(message)) return c.json({ error: message }, 404)
  if (/changed|revision|only available|already exists|requires|invalid|unknown|missing|must be/i.test(message)) {
    return c.json({ error: message }, 409)
  }
  return c.json({ error: message }, 400)
}

export function handleGetManualQa(c: Context) {
  const resolved = requireTicket(c)
  if (!resolved) return c.json({ error: 'Ticket not found' }, 404)
  try {
    return c.json(buildManualQaProjection(resolved.ticketId))
  } catch (error) {
    return manualQaError(c, error)
  }
}

export function handleGetManualQaVersion(c: Context) {
  const resolved = requireTicket(c)
  if (!resolved) return c.json({ error: 'Ticket not found' }, 404)
  try {
    const version = parseVersion(c)
    const detail = getManualQaVersionDetail(resolved.paths.ticketDir, version)
    if (!detail.checklist) return c.json({ error: 'Manual QA version not found' }, 404)
    const draftState = readManualQaDraftState(resolved.ticketId, version)
    const workspaceDrift = resolved.ticket.status === 'WAITING_MANUAL_QA'
      ? detectManualQaWorkspaceDrift(resolved.ticketId, version)
      : null
    const operationPath = getManualQaStoragePaths(resolved.paths.ticketDir, version).operationPath
    const operation = existsSync(operationPath) ? JSON.parse(readFileSync(operationPath, 'utf8')) : null
    const roundComplete = Boolean(detail.summary && detail.summary.outcome !== 'failed')
    return c.json({
      ...detail,
      version,
      status: roundComplete ? 'completed' : resolved.ticket.status === 'GENERATING_QA_CHECKLIST' ? 'generating' : 'waiting',
      draft: draftState?.data ?? detail.results,
      draftRevision: draftState?.revision ?? detail.results?.draftRevision ?? 0,
      readOnly: roundComplete || resolved.ticket.status !== 'WAITING_MANUAL_QA',
      workspaceDrift: workspaceDrift ? { detected: workspaceDrift.drifted, decisionRequired: workspaceDrift.drifted, files: workspaceDrift.files } : null,
      operation,
    })
  } catch (error) {
    return manualQaError(c, error)
  }
}

export async function handleUploadManualQaEvidence(c: Context) {
  const resolved = requireTicket(c)
  if (!resolved) return c.json({ error: 'Ticket not found' }, 404)
  const conflict = requireWaitingStatus(c, resolved.ticket)
  if (conflict) return conflict
  try {
    const version = parseVersion(c)
    const guard = parseMutationHeaders(c)
    assertChecklistHash(resolved.paths.ticketDir, version, guard.expectedChecklistHash)
    assertServerDraftRevision(resolved.ticketId, version, guard.expectedDraftRevision)
    const itemId = c.req.query('itemId')?.trim() ?? c.req.header('X-Checklist-Item-Id')?.trim() ?? ''
    const requestedEvidenceId = c.req.header('X-Evidence-Id')?.trim() ?? ''
    const previousReceipt = readManualQaEvidenceActionReceipt(resolved.paths.ticketDir, version, guard.actionId)
    if (previousReceipt) {
      if (
        previousReceipt.operation !== 'upload'
        || previousReceipt.evidence.itemId !== itemId
        || (requestedEvidenceId && previousReceipt.evidence.id !== requestedEvidenceId)
      ) {
        throw new Error('Evidence action ID was already used for another operation or checklist item.')
      }
      appendEvidenceEvent({
        ticketDir: resolved.paths.ticketDir,
        ticketExternalId: resolved.ticket.externalId,
        version,
        actionId: guard.actionId,
        operation: 'upload',
        itemId: previousReceipt.evidence.itemId,
        evidenceId: previousReceipt.evidence.id,
        createdAt: previousReceipt.createdAt,
      })
      return c.json({ evidence: previousReceipt.evidence, expectedDraftRevision: guard.expectedDraftRevision }, 200)
    }
    const encodedName = c.req.header('X-File-Name') ?? c.req.query('fileName') ?? 'evidence'
    let originalName = encodedName
    try { originalName = decodeURIComponent(encodedName) } catch { /* keep the sanitized raw header */ }
    const evidenceId = requestedEvidenceId || randomUUID()
    const existingEvidence = readManualQaEvidenceIndex(resolved.paths.ticketDir, version)
      .find((entry) => entry.id === evidenceId)
    if (existingEvidence) {
      const requestedMediaType = (c.req.header('Content-Type') ?? 'application/octet-stream').trim().toLowerCase()
      if (
        existingEvidence.itemId !== itemId
        || existingEvidence.originalName !== sanitizeEvidenceName(originalName)
        || existingEvidence.mediaType !== requestedMediaType
      ) throw new Error('Existing evidence does not match this upload retry.')
      const recovered = persistManualQaEvidenceActionReceipt(
        resolved.paths.ticketDir,
        version,
        guard.actionId,
        'upload',
        existingEvidence,
      )
      appendEvidenceEvent({
        ticketDir: resolved.paths.ticketDir,
        ticketExternalId: resolved.ticket.externalId,
        version,
        actionId: guard.actionId,
        operation: 'upload',
        itemId: existingEvidence.itemId,
        evidenceId: existingEvidence.id,
        createdAt: recovered.createdAt,
      })
      return c.json({ evidence: existingEvidence, expectedDraftRevision: guard.expectedDraftRevision }, 200)
    }
    const contentLength = Number(c.req.header('Content-Length') ?? '0')
    if (Number.isFinite(contentLength) && contentLength > MAX_MANUAL_QA_EVIDENCE_BYTES) {
      return c.json({ error: `Evidence file exceeds ${MAX_MANUAL_QA_EVIDENCE_BYTES} bytes.` }, 413)
    }
    const metadata = await streamManualQaEvidence({
      ticketDir: resolved.paths.ticketDir,
      version,
      itemId,
      evidenceId,
      originalName,
      mediaType: c.req.header('Content-Type') ?? 'application/octet-stream',
      body: c.req.raw.body,
    })
    persistManualQaEvidenceActionReceipt(resolved.paths.ticketDir, version, guard.actionId, 'upload', metadata)
    const receipt = readManualQaEvidenceActionReceipt(resolved.paths.ticketDir, version, guard.actionId)!
    appendEvidenceEvent({
      ticketDir: resolved.paths.ticketDir,
      ticketExternalId: resolved.ticket.externalId,
      version,
      actionId: guard.actionId,
      operation: 'upload',
      itemId: metadata.itemId,
      evidenceId: metadata.id,
      createdAt: receipt.createdAt,
    })
    return c.json({ evidence: metadata, expectedDraftRevision: guard.expectedDraftRevision }, 201)
  } catch (error) {
    if (error instanceof Error && error.message.includes('exceeds')) return c.json({ error: error.message }, 413)
    return manualQaError(c, error)
  }
}

export function handleReadManualQaEvidence(c: Context) {
  const resolved = requireTicket(c)
  if (!resolved) return c.json({ error: 'Ticket not found' }, 404)
  try {
    const found = resolveManualQaEvidence({
      ticketDir: resolved.paths.ticketDir,
      version: parseVersion(c),
      itemId: getRequiredRouteParam(c, 'itemId'),
      evidenceId: getRequiredRouteParam(c, 'evidenceId'),
    })
    const inline = c.req.query('inline') === 'true'
      && found.metadata.inlinePreview
      && isSafeRasterMediaType(found.metadata.mediaType)
    const filename = found.metadata.originalName.replace(/["\r\n]/g, '_')
    const body = Readable.toWeb(createReadStream(found.path)) as ReadableStream<Uint8Array>
    return new Response(body, {
      headers: {
        'Content-Type': found.metadata.mediaType,
        'Content-Length': String(found.metadata.size),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    return manualQaError(c, error)
  }
}

export async function handleRemoveManualQaEvidence(c: Context) {
  const resolved = requireTicket(c)
  if (!resolved) return c.json({ error: 'Ticket not found' }, 404)
  const conflict = requireWaitingStatus(c, resolved.ticket)
  if (conflict) return conflict
  try {
    const version = parseVersion(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const guard = Object.keys(body).length > 0 ? parseMutationBody(body) : parseMutationHeaders(c)
    assertChecklistHash(resolved.paths.ticketDir, version, guard.expectedChecklistHash)
    assertServerDraftRevision(resolved.ticketId, version, guard.expectedDraftRevision)
    const itemId = getRequiredRouteParam(c, 'itemId')
    const evidenceId = getRequiredRouteParam(c, 'evidenceId')
    const previousReceipt = readManualQaEvidenceActionReceipt(resolved.paths.ticketDir, version, guard.actionId)
    if (previousReceipt) {
      if (
        previousReceipt.operation !== 'remove'
        || previousReceipt.evidence.itemId !== itemId
        || previousReceipt.evidence.id !== evidenceId
      ) throw new Error('Evidence action ID was already used for another operation or evidence item.')
      if (previousReceipt.state === 'staged') {
        const stillPresent = readManualQaEvidenceIndex(resolved.paths.ticketDir, version)
          .some((entry) => entry.id === evidenceId && entry.itemId === itemId)
        if (stillPresent) {
          removeManualQaEvidence({
            ticketDir: resolved.paths.ticketDir,
            version,
            itemId,
            evidenceId,
            evidence: previousReceipt.evidence,
          })
        }
        persistManualQaEvidenceActionReceipt(
          resolved.paths.ticketDir,
          version,
          guard.actionId,
          'remove',
          previousReceipt.evidence,
          'complete',
        )
      }
      appendEvidenceEvent({
        ticketDir: resolved.paths.ticketDir,
        ticketExternalId: resolved.ticket.externalId,
        version,
        actionId: guard.actionId,
        operation: 'remove',
        itemId: previousReceipt.evidence.itemId,
        evidenceId: previousReceipt.evidence.id,
        createdAt: previousReceipt.createdAt,
      })
      return c.json({ success: true, removed: previousReceipt.evidence, expectedDraftRevision: guard.expectedDraftRevision })
    }
    const evidence = readManualQaEvidenceIndex(resolved.paths.ticketDir, version)
      .find((entry) => entry.id === evidenceId && entry.itemId === itemId)
    if (!evidence) throw new Error('Evidence was not found.')
    persistManualQaEvidenceActionReceipt(resolved.paths.ticketDir, version, guard.actionId, 'remove', evidence, 'staged')
    removeManualQaEvidence({ ticketDir: resolved.paths.ticketDir, version, itemId, evidenceId, evidence })
    persistManualQaEvidenceActionReceipt(resolved.paths.ticketDir, version, guard.actionId, 'remove', evidence, 'complete')
    const receipt = readManualQaEvidenceActionReceipt(resolved.paths.ticketDir, version, guard.actionId)!
    appendEvidenceEvent({
      ticketDir: resolved.paths.ticketDir,
      ticketExternalId: resolved.ticket.externalId,
      version,
      actionId: guard.actionId,
      operation: 'remove',
      itemId: evidence.itemId,
      evidenceId: evidence.id,
      createdAt: receipt.createdAt,
    })
    return c.json({ success: true, removed: evidence, expectedDraftRevision: guard.expectedDraftRevision })
  } catch (error) {
    return manualQaError(c, error)
  }
}

export async function handleSubmitManualQa(c: Context) {
  const resolved = requireTicket(c)
  if (!resolved) return c.json({ error: 'Ticket not found' }, 404)
  const conflict = requireWaitingStatus(c, resolved.ticket)
  if (conflict) return conflict
  try {
    const body = await c.req.json() as Record<string, unknown>
    const version = Number(body.version)
    const guard = {
      ...parseMutationBody(body),
      operationType: 'submit' as const,
    }
    const latest = assertServerDraftRevision(resolved.ticketId, version, guard.expectedDraftRevision)
    const draft = toCanonicalDraft({
      // Submission snapshots the server-owned autosave revision. Never accept a
      // parallel client draft that could diverge while reusing the same guard.
      raw: latest?.data,
      ticketExternalId: resolved.ticket.externalId,
      ticketDir: resolved.paths.ticketDir,
      version,
      checklistHash: guard.expectedChecklistHash,
      revision: guard.expectedDraftRevision,
      validateMergeGroups: true,
    })
    ensureActorForTicket(resolved.ticketId)
    const summary = await submitManualQa({
      ticketId: resolved.ticketId,
      version,
      draft,
      guard,
      sendEvent: (event) => sendTicketEvent(resolved.ticketId, event),
    })
    return c.json({ ...getManualQaVersionDetail(resolved.paths.ticketDir, version), version, status: summary.outcome, readOnly: true, summary })
  } catch (error) {
    return manualQaError(c, error)
  }
}

export async function handleSkipManualQa(c: Context) {
  const resolved = requireTicket(c)
  if (!resolved) return c.json({ error: 'Ticket not found' }, 404)
  const conflict = requireWaitingStatus(c, resolved.ticket)
  if (conflict) return conflict
  try {
    const body = await c.req.json() as Record<string, unknown>
    const version = Number(body.version)
    const mutation = parseMutationBody(body)
    const { expectedChecklistHash, expectedDraftRevision } = mutation
    const latest = assertServerDraftRevision(resolved.ticketId, version, expectedDraftRevision)
    const savedDraft = latest?.data && typeof latest.data === 'object' && !Array.isArray(latest.data)
      ? latest.data as Record<string, unknown>
      : {}
    const draft = toCanonicalDraft({
      raw: savedDraft,
      ticketExternalId: resolved.ticket.externalId,
      ticketDir: resolved.paths.ticketDir,
      version,
      checklistHash: expectedChecklistHash,
      revision: expectedDraftRevision,
    })
    ensureActorForTicket(resolved.ticketId)
    const summary = await skipManualQa({
      ticketId: resolved.ticketId,
      version,
      draft,
      guard: {
        actionId: mutation.actionId,
        operationType: 'skip',
        expectedChecklistHash,
        expectedDraftRevision,
      },
      reason: typeof savedDraft.skipReason === 'string'
        ? savedDraft.skipReason
        : undefined,
      sendEvent: (event) => sendTicketEvent(resolved.ticketId, event),
    })
    return c.json({ ...getManualQaVersionDetail(resolved.paths.ticketDir, version), version, status: 'skipped', readOnly: true, summary })
  } catch (error) {
    return manualQaError(c, error)
  }
}

async function handleManualQaDriftDecision(c: Context, decision: 'include' | 'discard') {
  const resolved = requireTicket(c)
  if (!resolved) return c.json({ error: 'Ticket not found' }, 404)
  const conflict = requireWaitingStatus(c, resolved.ticket)
  if (conflict) return conflict
  try {
    const body = await c.req.json() as Record<string, unknown>
    const version = Number(body.version)
    const { actionId, expectedChecklistHash, expectedDraftRevision } = parseMutationBody(body)
    assertChecklistHash(resolved.paths.ticketDir, version, expectedChecklistHash)
    assertServerDraftRevision(resolved.ticketId, version, expectedDraftRevision)
    const currentDrift = detectManualQaWorkspaceDrift(resolved.ticketId, version)
    const files = Array.isArray(body.files)
      ? body.files.filter((entry): entry is string => typeof entry === 'string')
      : currentDrift.files.map((entry) => entry.path)
    const receipt = decision === 'include'
      ? includeManualQaWorkspaceDrift(resolved.ticketId, version, files, actionId)
      : discardManualQaWorkspaceDrift(resolved.ticketId, version, files, actionId)
    return c.json({ ...getManualQaVersionDetail(resolved.paths.ticketDir, version), version, status: 'waiting', workspaceDrift: { detected: false, files: [] }, operation: { status: 'drift_resolved', receipt } })
  } catch (error) {
    return manualQaError(c, error)
  }
}

export function handleIncludeManualQaDrift(c: Context) {
  return handleManualQaDriftDecision(c, 'include')
}

export function handleDiscardManualQaDrift(c: Context) {
  return handleManualQaDriftDecision(c, 'discard')
}
