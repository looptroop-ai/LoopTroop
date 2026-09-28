import { lstatSync } from 'node:fs'
import { readFileNoFollowSync } from '../io/readFile'
import { detectGitBaseBranch } from '../storage/paths'
import { resolveProjectTicketContainedPath, writeProjectTicketFile } from './containedPath'

export interface TicketMetaRecord {
  externalId?: string
  title?: string
  createdAt?: string
  baseBranch?: string
  startedAt?: string
  lockedMainImplementer?: string | null
  lockedCouncilMembers?: string[]
}

interface TicketModelSelectionLock {
  startedAt: string
  lockedMainImplementer: string
  lockedCouncilMembers: string[]
}

export class TicketMetadataFormatError extends SyntaxError {
  constructor() {
    super('Ticket metadata must contain a JSON object before the ticket can start.')
    this.name = 'TicketMetadataFormatError'
  }
}

function normalizeModelId(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

function normalizeModelList(values: Array<string | null | undefined> | null | undefined): string[] {
  if (!values) return []

  const seen = new Set<string>()
  const normalized: string[] = []

  for (const value of values) {
    const modelId = normalizeModelId(value)
    if (!modelId || seen.has(modelId)) continue
    seen.add(modelId)
    normalized.push(modelId)
  }

  return normalized
}

/**
 * Order-sensitive comparison of a council roster.
 *
 * Order is load-bearing: `selectWinner` treats `members[0]` as the main
 * implementer, so reordering the roster changes who implements the ticket and
 * must invalidate the model lock.
 */
export function councilMembersEqualOrdered(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

export function getTicketMetaPath(projectRoot: string, externalId: string): string {
  return resolveProjectTicketContainedPath(projectRoot, externalId, 'meta/ticket.meta.json')
}

function parseTicketMeta(path: string): TicketMetaRecord {
  const contents = readFileNoFollowSync(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch (error) {
    if (error instanceof SyntaxError) throw new TicketMetadataFormatError()
    throw error
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TicketMetadataFormatError()
  }
  return parsed as TicketMetaRecord
}

export function readTicketMeta(projectRoot: string, externalId: string): TicketMetaRecord {
  const path = getTicketMetaPath(projectRoot, externalId)
  try {
    return parseTicketMeta(path)
  } catch {
    return {}
  }
}

/** Read metadata for a write-modify operation without treating I/O errors as an empty record. */
export function readTicketMetaForMutation(projectRoot: string, externalId: string): TicketMetaRecord {
  const path = getTicketMetaPath(projectRoot, externalId)
  try {
    return parseTicketMeta(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

export function writeTicketMeta(projectRoot: string, externalId: string, meta: TicketMetaRecord): TicketMetaRecord {
  writeProjectTicketFile(projectRoot, externalId, 'meta/ticket.meta.json', JSON.stringify(meta, null, 2))
  return meta
}

export function updateTicketMeta(
  projectRoot: string,
  externalId: string,
  patch: Partial<TicketMetaRecord>,
): TicketMetaRecord {
  const current = readTicketMetaForMutation(projectRoot, externalId)
  return writeTicketMeta(projectRoot, externalId, { ...current, ...patch })
}

export function prepareTicketModelSelectionLock(
  projectRoot: string,
  externalId: string,
  lock: TicketModelSelectionLock,
  replaceExisting = false,
): TicketMetaRecord {
  const lockedMainImplementer = normalizeModelId(lock.lockedMainImplementer)
  const lockedCouncilMembers = normalizeModelList(lock.lockedCouncilMembers)

  if (!lockedMainImplementer) {
    throw new Error('Locked main implementer is required.')
  }
  if (lockedCouncilMembers.length === 0) {
    throw new Error('Locked council members are required.')
  }

  const current = readTicketMetaForMutation(projectRoot, externalId)
  const currentMainImplementer = normalizeModelId(current.lockedMainImplementer)
  const currentCouncilMembers = normalizeModelList(current.lockedCouncilMembers)

  if (!replaceExisting && currentMainImplementer && currentMainImplementer !== lockedMainImplementer) {
    throw new Error(`Ticket model configuration is immutable after start: ${externalId}`)
  }
  if (!replaceExisting && currentCouncilMembers.length > 0 && !councilMembersEqualOrdered(currentCouncilMembers, lockedCouncilMembers)) {
    throw new Error(`Ticket model configuration is immutable after start: ${externalId}`)
  }

  return {
    ...current,
    startedAt: replaceExisting ? lock.startedAt : current.startedAt ?? lock.startedAt,
    lockedMainImplementer: replaceExisting ? lockedMainImplementer : currentMainImplementer ?? lockedMainImplementer,
    lockedCouncilMembers: replaceExisting || currentCouncilMembers.length === 0
      ? lockedCouncilMembers
      : currentCouncilMembers,
  }
}

export function clearTicketModelSelectionLock(projectRoot: string, externalId: string): TicketMetaRecord {
  const current = readTicketMetaForMutation(projectRoot, externalId)
  if (!('startedAt' in current || 'lockedMainImplementer' in current || 'lockedCouncilMembers' in current)) {
    return current
  }

  const { startedAt: _startedAt, lockedMainImplementer: _lockedMainImplementer, lockedCouncilMembers: _lockedCouncilMembers, ...unlocked } = current
  return writeTicketMeta(projectRoot, externalId, unlocked)
}

export function resolveTicketBaseBranch(projectRoot: string, externalId: string): string {
  const meta = readTicketMeta(projectRoot, externalId)
  if (typeof meta.baseBranch === 'string' && meta.baseBranch.trim().length > 0) {
    return meta.baseBranch.trim()
  }

  const detected = detectGitBaseBranch(projectRoot)
  // Read-side enrichment must not recreate a deleted worktree or its .ticket directory.
  let ticketDirExists = false
  try {
    ticketDirExists = lstatSync(resolveProjectTicketContainedPath(projectRoot, externalId, '.')).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (ticketDirExists) {
    try {
      updateTicketMeta(projectRoot, externalId, { baseBranch: detected })
    } catch (error) {
      // Keep read-only ticket projections available when stored metadata is malformed.
      if (!(error instanceof TicketMetadataFormatError)) throw error
    }
  }
  return detected
}

export function getTicketBeadsDir(
  projectRoot: string,
  externalId: string,
  baseBranch?: string,
): string {
  const resolvedBaseBranch = baseBranch ?? resolveTicketBaseBranch(projectRoot, externalId)
  return resolveProjectTicketContainedPath(projectRoot, externalId, `beads/${resolvedBaseBranch}/.beads`)
}

export function getTicketBeadsPath(
  projectRoot: string,
  externalId: string,
  baseBranch?: string,
): string {
  const branch = baseBranch ?? resolveTicketBaseBranch(projectRoot, externalId)
  return resolveProjectTicketContainedPath(projectRoot, externalId, `beads/${branch}/.beads/issues.jsonl`)
}
