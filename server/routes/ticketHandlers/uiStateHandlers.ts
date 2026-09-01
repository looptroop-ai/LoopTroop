import type { Context } from 'hono'
import { MAX_UI_STATE_BYTES } from '../../lib/constants'
import { contentSha256 } from '../../lib/contentHash'
import {
  getLatestPhaseArtifact,
  getTicketByRef,
  upsertLatestPhaseArtifact,
} from '../../storage/tickets'
import { getErrorMessage } from '@shared/typeGuards'
import { getTicketParam } from './routeUtils'
import { uiStateScopeSchema, upsertUiStateSchema } from './schemas'

const UI_STATE_PHASE = 'UI_STATE'
const UI_STATE_ARTIFACT_PREFIX = 'ui_state:'

function uiStateArtifactType(scope: string): string {
  return `${UI_STATE_ARTIFACT_PREFIX}${scope}`
}

export interface PersistedUiState {
  data: unknown
  updatedAt: string | null
  revision: number
  lastActionId: string | null
  lastActionHash: string | null
}

interface UiStateWriteResult extends PersistedUiState {
  conflict: boolean
}

const uiStateSaveQueues = new Map<string, Promise<void>>()

export function readTicketUiState(ticketId: string, scope: string): PersistedUiState | null {
  const artifact = getLatestPhaseArtifact(ticketId, uiStateArtifactType(scope), UI_STATE_PHASE)
  if (!artifact) return null

  try {
    const parsed = JSON.parse(artifact.content) as {
      data?: unknown
      updatedAt?: string | null
      revision?: unknown
      clientRevision?: unknown
      lastActionId?: unknown
      lastActionHash?: unknown
    }
    if (parsed && typeof parsed === 'object' && 'data' in parsed) {
      return {
        data: parsed.data,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : artifact.createdAt,
        revision: typeof parsed.revision === 'number' && Number.isInteger(parsed.revision) && parsed.revision >= 0
          ? parsed.revision
          : typeof parsed.clientRevision === 'number' && Number.isInteger(parsed.clientRevision) && parsed.clientRevision >= 0
            ? parsed.clientRevision
            : 0,
        lastActionId: typeof parsed.lastActionId === 'string' ? parsed.lastActionId : null,
        lastActionHash: typeof parsed.lastActionHash === 'string' ? parsed.lastActionHash : null,
      }
    }
    return { data: parsed, updatedAt: artifact.createdAt, revision: 0, lastActionId: null, lastActionHash: null }
  } catch {
    return { data: null, updatedAt: artifact.createdAt, revision: 0, lastActionId: null, lastActionHash: null }
  }
}

function upsertUiState(
  ticketId: string,
  scope: string,
  data: unknown,
  expectedRevision: number | null,
  actionId: string,
): UiStateWriteResult {
  const existing = readTicketUiState(ticketId, scope)
  const actionHash = contentSha256(JSON.stringify({ expectedRevision: expectedRevision ?? 0, data }))
  if (existing?.lastActionId === actionId) {
    if (existing.lastActionHash !== actionHash) {
      return {
        ...existing,
        conflict: true,
      }
    }
    return {
      ...existing,
      conflict: false,
    }
  }

  const currentRevision = existing?.revision ?? 0
  const normalizedExpectedRevision = expectedRevision ?? 0
  if (normalizedExpectedRevision !== currentRevision) {
    return {
      data: existing?.data ?? null,
      updatedAt: existing?.updatedAt ?? null,
      revision: currentRevision,
      lastActionId: existing?.lastActionId ?? null,
      lastActionHash: existing?.lastActionHash ?? null,
      conflict: true,
    }
  }

  const now = new Date().toISOString()
  const revision = currentRevision + 1
  const payload = JSON.stringify({ data, updatedAt: now, revision, lastActionId: actionId, lastActionHash: actionHash })
  if (Buffer.byteLength(payload, 'utf8') > MAX_UI_STATE_BYTES) {
    throw new Error(`UI state payload exceeds ${MAX_UI_STATE_BYTES} bytes`)
  }

  upsertLatestPhaseArtifact(ticketId, uiStateArtifactType(scope), UI_STATE_PHASE, payload)
  return { data, updatedAt: now, revision, lastActionId: actionId, lastActionHash: actionHash, conflict: false }
}

async function serializeUiStateSave<T>(ticketId: string, scope: string, save: () => T): Promise<T> {
  const key = `${ticketId}\u0000${scope}`
  const previous = uiStateSaveQueues.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.catch(() => undefined).then(() => current)
  uiStateSaveQueues.set(key, tail)
  await previous.catch(() => undefined)
  try {
    return save()
  } finally {
    release()
    if (uiStateSaveQueues.get(key) === tail) uiStateSaveQueues.delete(key)
  }
}

export function handleGetUiState(c: Context) {
  const ticketId = getTicketParam(c)
  const parsed = uiStateScopeSchema.safeParse({ scope: c.req.query('scope') ?? '' })
  if (!parsed.success) {
    return c.json({ error: 'Invalid scope', details: parsed.error.flatten() }, 400)
  }

  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)

  const state = readTicketUiState(ticketId, parsed.data.scope)
  if (!state) {
    return c.json({
      scope: parsed.data.scope,
      exists: false,
      data: null,
      updatedAt: null,
      revision: 0,
      clientRevision: null,
    })
  }

  return c.json({
    scope: parsed.data.scope,
    exists: true,
    data: state.data,
    updatedAt: state.updatedAt,
    revision: state.revision,
    clientRevision: state.revision,
  })
}

export async function handlePutUiState(c: Context) {
  const ticketId = getTicketParam(c)
  const body = await c.req.json().catch(() => ({}))
  const parsed = upsertUiStateSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid UI state payload', details: parsed.error.flatten() }, 400)
  }

  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)

  try {
    const result = await serializeUiStateSave(ticketId, parsed.data.scope, () => upsertUiState(
      ticketId,
      parsed.data.scope,
      parsed.data.data,
      parsed.data.expectedRevision,
      parsed.data.actionId,
    ))
    if (result.conflict) {
      return c.json({
        error: 'UI state revision conflict',
        conflict: true,
        scope: parsed.data.scope,
        exists: result.updatedAt !== null,
        data: result.data,
        updatedAt: result.updatedAt,
        revision: result.revision,
        clientRevision: result.revision,
      }, 409)
    }
    return c.json({
      success: true,
      conflict: false,
      scope: parsed.data.scope,
      updatedAt: result.updatedAt,
      revision: result.revision,
      clientRevision: result.revision,
    })
  } catch (err) {
    return c.json({ error: 'Failed to persist UI state', details: getErrorMessage(err) }, 500)
  }
}
