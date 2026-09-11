import { statSync } from 'node:fs'
import { readFileNoFollowSync } from '../io/readFile'
import { detectGitBaseBranch, getTicketWorktreePath } from '../storage/paths'
import { resolveProjectTicketContainedPath, writeProjectTicketFile } from './containedPath'
import { resolveContainedPath } from '../lib/containedPath'

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

export function readTicketMeta(projectRoot: string, externalId: string): TicketMetaRecord {
  const path = getTicketMetaPath(projectRoot, externalId)
  try {
    const parsed = JSON.parse(readFileNoFollowSync(path)) as TicketMetaRecord
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
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
  const current = readTicketMeta(projectRoot, externalId)
  return writeTicketMeta(projectRoot, externalId, { ...current, ...patch })
}

export function lockTicketModelSelection(
  projectRoot: string,
  externalId: string,
  lock: TicketModelSelectionLock,
): TicketMetaRecord {
  const lockedMainImplementer = normalizeModelId(lock.lockedMainImplementer)
  const lockedCouncilMembers = normalizeModelList(lock.lockedCouncilMembers)

  if (!lockedMainImplementer) {
    throw new Error('Locked main implementer is required.')
  }
  if (lockedCouncilMembers.length === 0) {
    throw new Error('Locked council members are required.')
  }

  const current = readTicketMeta(projectRoot, externalId)
  const currentMainImplementer = normalizeModelId(current.lockedMainImplementer)
  const currentCouncilMembers = normalizeModelList(current.lockedCouncilMembers)

  if (currentMainImplementer && currentMainImplementer !== lockedMainImplementer) {
    throw new Error(`Ticket model configuration is immutable after start: ${externalId}`)
  }
  if (currentCouncilMembers.length > 0 && !councilMembersEqualOrdered(currentCouncilMembers, lockedCouncilMembers)) {
    throw new Error(`Ticket model configuration is immutable after start: ${externalId}`)
  }

  return writeTicketMeta(projectRoot, externalId, {
    ...current,
    startedAt: current.startedAt ?? lock.startedAt,
    lockedMainImplementer: currentMainImplementer ?? lockedMainImplementer,
    lockedCouncilMembers: currentCouncilMembers.length > 0 ? currentCouncilMembers : lockedCouncilMembers,
  })
}

export function resolveTicketBaseBranch(projectRoot: string, externalId: string): string {
  const meta = readTicketMeta(projectRoot, externalId)
  if (typeof meta.baseBranch === 'string' && meta.baseBranch.trim().length > 0) {
    return meta.baseBranch.trim()
  }

  const detected = detectGitBaseBranch(projectRoot)
  // Only persist when the worktree still exists; otherwise we'd recreate deleted directories.
  let worktreeExists = false
  try {
    worktreeExists = statSync(resolveContainedPath(projectRoot, getTicketWorktreePath(projectRoot, externalId))).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (worktreeExists) {
    updateTicketMeta(projectRoot, externalId, { baseBranch: detected })
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
