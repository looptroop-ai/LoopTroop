import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { and, eq } from 'drizzle-orm'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { safeAtomicWrite } from '../../io/atomicWrite'
import { writeJsonl } from '../../io/jsonl'
import { readBeadsFile } from '../beads/beadsFile'
import {
  archiveActivePhaseAttempts,
  createFreshPhaseAttempts,
  createManualQaImprovementTicket,
  getLatestPhaseArtifact,
  getTicketContext,
  getTicketByRef,
  getTicketPaths,
  isDisplayOnlyMockTicket,
  insertPhaseArtifact,
  listPhaseAttempts,
  listTickets,
  patchTicket,
  resolvePhaseAttempt,
} from '../../storage/tickets'
import { manualQaOperations } from '../../db/schema'
import type { TicketEvent } from '../../machines/types'
import { buildTicketContextFromTicket } from '../../machines/ticketContext'
import type { Bead, QaOriginEvidenceRef } from '../beads/types'
import { captureFinalTestDirtyFiles } from '../finalTest/fileEffectsAudit'
import { fetchProviderCatalog, flattenCatalogModels } from '../../opencode/providerCatalog'
import { composeManualQaImprovementDescription } from '../../../shared/manualQaImprovement'
import { parseYamlOrJsonCandidate } from '../../structuredOutput/yamlUtils'
import {
  MANUAL_QA_SCHEMA_VERSION,
  ManualQaDraftSchema,
  ManualQaImprovementOriginSchema,
  type ManualQaChecklist,
  type ManualQaDraft,
  type ManualQaEvidenceRef,
  type ManualQaImprovementDraft,
  type ManualQaItemResult,
  type ManualQaModelCapabilitySnapshot,
  type ManualQaResults,
  type ManualQaSummary,
} from './types'
import {
  appendManualQaEvent,
  getManualQaChecklistHash,
  getManualQaStoragePaths,
  persistManualQaResults,
  persistManualQaModelCapabilitySnapshot,
  persistManualQaSummary,
  readManualQaChecklist,
  readManualQaCoverage,
  readManualQaEvidenceIndex,
  readManualQaModelCapabilitySnapshot,
  readManualQaResults,
  readManualQaSummary,
  resolveManualQaEvidence,
  resolveManualQaTicketDir,
  sanitizeEvidenceName,
  snapshotManualQaDraft,
} from './storage'
import {
  buildManualQaFixGroups,
  generateManualQaFixBeadCandidates,
  hydrateManualQaFixBeads,
  persistManualQaFixBeadCandidates,
  readManualQaFixBeadCandidates,
  type GenerateManualQaFixBeadsInput,
  type ManualQaFixBeadCandidate,
} from './fixBeads'
import { emitAiMilestone, emitPhaseLog } from '../../workflow/phases/helpers'
import { getErrorMessage } from '@shared/typeGuards'

export interface ManualQaMutationGuard {
  actionId: string
  operationType: 'submit' | 'skip'
  expectedChecklistHash: string
  expectedDraftRevision: number
}

export interface ManualQaWorkspaceDrift {
  drifted: boolean
  headChanged: boolean
  baselineHead: string
  currentHead: string
  files: ReturnType<typeof captureFinalTestDirtyFiles>
}

interface ManualQaOperationJournal {
  schemaVersion: 1
  actionId: string
  operationType: 'submit' | 'skip'
  ticketId: string
  version: number
  checklistHash: string
  draftRevision: number
  state: 'staged' | 'generating_beads' | 'creating_improvements' | 'creating_beads' | 'complete'
  improvementTicketIds: string[]
  fixBeadIds: string[]
  sourcePhaseAttempts?: Record<string, number>
  createdAt: string
  updatedAt: string
}

function runGitHead(worktreePath: string): string {
  const result = spawnSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0 || result.error) throw new Error('Unable to read Manual QA workspace HEAD.')
  return (result.stdout ?? '').trim()
}

function runGitText(worktreePath: string, args: string[]): string {
  const result = spawnSync('git', ['-C', worktreePath, ...args], { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0 || result.error) throw new Error(`Unable to audit Manual QA workspace: git ${args[0] ?? ''} failed.`)
  return (result.stdout ?? '').trim()
}

export function detectManualQaWorkspaceDrift(ticketId: string, version: number): ManualQaWorkspaceDrift {
  const ticket = getTicketByRef(ticketId)
  if (ticket && isDisplayOnlyMockTicket(ticket)) {
    return {
      drifted: false,
      headChanged: false,
      baselineHead: '0000000000000000000000000000000000000000',
      currentHead: '0000000000000000000000000000000000000000',
      files: [],
    }
  }
  const paths = getTicketPaths(ticketId)
  if (!paths) throw new Error(`Ticket storage was not found: ${ticketId}`)
  const baselinePath = getManualQaStoragePaths(paths.ticketDir, version).baselinePath
  if (!existsSync(baselinePath)) throw new Error('Manual QA workspace baseline is missing.')
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as { head: string; trackedSignatures?: Record<string, string> }
  const currentHead = runGitHead(paths.worktreePath)
  const dirtyFiles = captureFinalTestDirtyFiles(paths.worktreePath)
  const currentSignatures: Record<string, string> = {}
  for (const entry of runGitText(paths.worktreePath, ['ls-files', '-s', '-z']).split('\0')) {
    const match = entry.match(/^\d+ ([0-9a-f]+) \d+\t(.+)$/)
    if (match?.[1] && match[2]) currentSignatures[match[2]] = match[1]
  }
  const signaturePaths = new Set([
    ...Object.keys(baseline.trackedSignatures ?? {}),
    ...Object.keys(currentSignatures),
  ])
  const committedPaths = new Set<string>()
  for (const path of signaturePaths) {
    if ((baseline.trackedSignatures ?? {})[path] !== currentSignatures[path]) committedPaths.add(path)
  }
  if (baseline.head !== currentHead) {
    for (const line of runGitText(paths.worktreePath, ['diff', '--name-status', baseline.head, currentHead, '--', '.', ':(top,exclude).ticket', ':(top,exclude).looptroop']).split('\n')) {
      const fields = line.split('\t')
      for (const path of fields.slice(1)) if (path) committedPaths.add(path)
    }
  }
  const dirtyPaths = new Set(dirtyFiles.map((entry) => entry.path))
  const files = [
    ...dirtyFiles,
    ...[...committedPaths].filter((path) => !dirtyPaths.has(path)).map((path) => ({
      path,
      indexStatus: 'C',
      worktreeStatus: ' ',
      rawStatus: 'C ',
      untracked: !(path in currentSignatures),
      contentSignature: currentSignatures[path] ?? null,
    })),
  ]
  return {
    drifted: baseline.head !== currentHead || files.length > 0,
    headChanged: baseline.head !== currentHead,
    baselineHead: baseline.head,
    currentHead,
    files,
  }
}

function assertMutationGuard(ticketId: string, ticketDir: string, version: number, draft: ManualQaDraft, guard: ManualQaMutationGuard): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(guard.actionId)) {
    throw new Error('Manual QA mutation requires a valid action ID.')
  }
  if (!/^[a-f0-9]{64}$/.test(guard.expectedChecklistHash)) {
    throw new Error('Manual QA mutation requires a valid checklist hash.')
  }
  if (!Number.isInteger(guard.expectedDraftRevision) || guard.expectedDraftRevision < 0) {
    throw new Error('Manual QA mutation requires a valid draft revision.')
  }
  const checklistHash = getManualQaChecklistHash(ticketDir, version)
  if (!checklistHash || checklistHash !== guard.expectedChecklistHash || checklistHash !== draft.checklistHash) {
    throw new Error('Manual QA checklist changed; reload the active version before submitting.')
  }
  if (draft.draftRevision !== guard.expectedDraftRevision) {
    throw new Error('Manual QA draft revision changed; reload before submitting.')
  }
  const uiState = getLatestPhaseArtifact(ticketId, `ui_state:manual_qa_draft:v${version}`, 'UI_STATE')
  let serverRevision = 0
  if (uiState) {
    try {
      const parsed = JSON.parse(uiState.content) as { revision?: unknown }
      serverRevision = typeof parsed.revision === 'number' && Number.isInteger(parsed.revision) ? parsed.revision : 0
    } catch {
      throw new Error('Stored Manual QA draft state is invalid.')
    }
  }
  if (serverRevision !== guard.expectedDraftRevision) {
    throw new Error('Manual QA draft revision conflict; reload the server-owned draft before submitting.')
  }
}

function validateSubmission(
  checklist: ManualQaChecklist,
  draft: ManualQaDraft,
  storedEvidence: ManualQaEvidenceRef[],
): void {
  const items = new Map(checklist.items.map((item, index) => [item.id, { item, index }]))
  const itemLabel = (itemId: string) => {
    const entry = items.get(itemId)
    return entry
      ? `Item ${entry.index + 1} ${entry.item.title?.trim() || entry.item.behavior}`
      : `Checklist item ${itemId}`
  }
  const results = new Map<string, ManualQaItemResult>()
  for (const result of draft.results) {
    if (!items.has(result.itemId)) throw new Error(`Result references unknown checklist item: ${result.itemId}`)
    if (results.has(result.itemId)) throw new Error(`${itemLabel(result.itemId)} has more than one result.`)
    results.set(result.itemId, result)
  }
  for (const item of checklist.items) {
    const outcome = results.get(item.id)?.outcome ?? 'pending'
    if (item.severity === 'required' && !['pass', 'fail', 'waive', 'improvement'].includes(outcome)) {
      throw new Error(`${itemLabel(item.id)} is required and must be passed, failed, waived, or recorded as an improvement.`)
    }
  }

  for (const result of draft.results) {
    if (result.outcome === 'fail' && !result.observation.trim()) {
      throw new Error(`${itemLabel(result.itemId)} is marked Fail and requires an observation.`)
    }
  }

  const improvementById = new Map(draft.improvements.map((improvement) => [improvement.id, improvement]))
  for (const result of draft.results) {
    if (result.outcome !== 'improvement') continue
    const improvement = result.improvementDraftId ? improvementById.get(result.improvementDraftId) : null
    if (!improvement || improvement.itemId !== result.itemId) {
      throw new Error(`${itemLabel(result.itemId)} is marked Improvement but does not have a matching reviewed draft.`)
    }
    if (!improvement.title.trim()) throw new Error(`${itemLabel(result.itemId)} is marked Improvement and requires a title.`)
    if (!improvement.description.trim()) throw new Error(`${itemLabel(result.itemId)} is marked Improvement and requires a description.`)
    if (improvement.contextOverride !== undefined && !improvement.contextOverride.trim()) {
      throw new Error(`${itemLabel(result.itemId)} is marked Improvement and cannot have empty Manual QA context.`)
    }
  }

  const canonicalEvidence = new Map(storedEvidence.map((entry) => [entry.id, entry]))
  for (const draftEvidence of draft.evidence) {
    const stored = canonicalEvidence.get(draftEvidence.id)
    if (!stored) {
      throw new Error(`${itemLabel(draftEvidence.itemId)} references file "${draftEvidence.originalName}", but that file is no longer available.`)
    }
    if (
      stored.itemId !== draftEvidence.itemId
      || stored.sha256 !== draftEvidence.sha256
      || stored.storedName !== draftEvidence.storedName
    ) throw new Error(`${itemLabel(draftEvidence.itemId)} could not use file "${draftEvidence.originalName}" because its saved metadata changed; reload Manual QA and try again.`)
  }
  const assertEvidenceBelongsToItem = (evidenceId: string, itemId: string) => {
    const evidence = canonicalEvidence.get(evidenceId)
    const draftEvidence = draft.evidence.find((entry) => entry.id === evidenceId)
    if (!evidence) {
      throw new Error(`${itemLabel(itemId)} references file "${draftEvidence?.originalName ?? 'Unknown file'}", but that file is no longer available.`)
    }
    if (evidence.itemId !== itemId) {
      throw new Error(`${itemLabel(itemId)} references file "${evidence.originalName}", but that file belongs to ${itemLabel(evidence.itemId).replace(/^Item/, 'item')}.`)
    }
  }
  for (const result of draft.results) {
    for (const evidenceId of result.evidenceIds) assertEvidenceBelongsToItem(evidenceId, result.itemId)
  }
  for (const improvement of draft.improvements) {
    for (const evidenceId of improvement.evidenceIds) assertEvidenceBelongsToItem(evidenceId, improvement.itemId)
  }
}

function canonicalizeSubmissionEvidence(
  checklist: ManualQaChecklist,
  draft: ManualQaDraft,
  storedEvidence: ManualQaEvidenceRef[],
): ManualQaDraft {
  const canonicalById = new Map(storedEvidence.map((entry) => [entry.id, entry]))
  const itemById = new Map(checklist.items.map((item, index) => [item.id, { item, index }]))
  const itemLabel = (itemId: string) => {
    const entry = itemById.get(itemId)
    return entry
      ? `Item ${entry.index + 1} ${entry.item.title?.trim() || entry.item.behavior}`
      : `Checklist item ${itemId}`
  }
  const canonicalEvidenceIds = (evidenceIds: string[], itemId: string) => [...new Set(evidenceIds)].filter((evidenceId) => {
    const evidence = canonicalById.get(evidenceId)
    if (!evidence) return false
    if (evidence.itemId !== itemId) {
      throw new Error(`${itemLabel(itemId)} references file "${evidence.originalName}", but that file belongs to ${itemLabel(evidence.itemId).replace(/^Item/, 'item')}.`)
    }
    return true
  })

  return {
    ...draft,
    results: draft.results.map((result) => ({
      ...result,
      evidenceIds: canonicalEvidenceIds(result.evidenceIds, result.itemId),
    })),
    improvements: draft.improvements.map((improvement) => ({
      ...improvement,
      evidenceIds: canonicalEvidenceIds(improvement.evidenceIds, improvement.itemId),
    })),
    evidence: storedEvidence,
  }
}

function deterministicId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`
}

function emitManualQaOperationMilestone(ticketId: string, externalId: string, message: string, suffix: string): void {
  emitAiMilestone(ticketId, externalId, 'WAITING_MANUAL_QA', message, suffix, {
    source: 'system',
    phaseAttempt: resolvePhaseAttempt(ticketId, 'WAITING_MANUAL_QA'),
  })
}

function writeJournal(path: string, journal: ManualQaOperationJournal): void {
  safeAtomicWrite(path, JSON.stringify(journal, null, 2))
}

function persistManualQaDatabaseOperation(ticketId: string, journal: ManualQaOperationJournal): void {
  const context = getTicketContext(ticketId)
  if (!context) throw new Error(`Ticket was not found for Manual QA operation: ${ticketId}`)
  context.projectDb.insert(manualQaOperations).values({
    ticketId: context.localTicketId,
    actionId: journal.actionId,
    version: journal.version,
    checklistHash: journal.checklistHash,
    draftRevision: journal.draftRevision,
    state: journal.state,
    payload: JSON.stringify(journal),
    updatedAt: journal.updatedAt,
  }).onConflictDoNothing().run()
  const existing = context.projectDb.select().from(manualQaOperations).where(and(
    eq(manualQaOperations.ticketId, context.localTicketId),
    eq(manualQaOperations.actionId, journal.actionId),
  )).get()
  if (!existing) throw new Error('Failed to persist Manual QA database idempotency record.')
  if (
    existing.version !== journal.version
    || existing.checklistHash !== journal.checklistHash
    || existing.draftRevision !== journal.draftRevision
  ) throw new Error('Manual QA action ID was already used with different database input.')
  context.projectDb.update(manualQaOperations).set({
    state: journal.state,
    payload: JSON.stringify(journal),
    updatedAt: journal.updatedAt,
  }).where(eq(manualQaOperations.id, existing.id)).run()
}

export function reserveManualQaSubmissionOperation(input: {
  path: string
  actionId: string
  operationType: ManualQaOperationJournal['operationType']
  ticketId: string
  version: number
  checklistHash: string
  draftRevision: number
}): ManualQaOperationJournal {
  if (existsSync(input.path)) {
    const existing = JSON.parse(readFileSync(input.path, 'utf8')) as ManualQaOperationJournal
    if (
      existing.actionId !== input.actionId
      || existing.operationType !== input.operationType
      || existing.ticketId !== input.ticketId
      || existing.version !== input.version
      || existing.checklistHash !== input.checklistHash
      || existing.draftRevision !== input.draftRevision
    ) throw new Error('Manual QA submission action ID was already used with different input.')
    return existing
  }
  const now = new Date().toISOString()
  const journal: ManualQaOperationJournal = {
    schemaVersion: MANUAL_QA_SCHEMA_VERSION,
    actionId: input.actionId,
    operationType: input.operationType,
    ticketId: input.ticketId,
    version: input.version,
    checklistHash: input.checklistHash,
    draftRevision: input.draftRevision,
    state: 'staged',
    improvementTicketIds: [],
    fixBeadIds: [],
    createdAt: now,
    updatedAt: now,
  }
  writeJournal(input.path, journal)
  return journal
}

function evidenceForIds(evidence: ManualQaEvidenceRef[], ids: string[]): ManualQaEvidenceRef[] {
  const wanted = new Set(ids)
  return evidence.filter((entry) => wanted.has(entry.id))
}

export function buildImprovementDescription(input: {
  description: string
  contextOverride?: string
  title?: string
  sourceExternalId: string
  version: number
  itemId: string
  behavior: string
  source?: string
  expectedResult: string
  actions?: string[]
  userNote?: string
  improvementTitle?: string
  observation?: string
  evidence: ManualQaEvidenceRef[]
  links?: Array<{ url: string; label?: string }>
  prdRefs?: string[]
  beadRefs?: string[]
  prdRequirements?: string[]
  beadWorkAreas?: string[]
  evidenceSummary?: string
}): { description: string; omittedCharacters: number; omittedFields: string[] } {
  const composed = composeManualQaImprovementDescription({
    description: input.description,
    contextOverride: input.contextOverride,
    itemTitle: input.title ?? input.behavior,
    behavior: input.behavior,
    source: input.source,
    expectedResult: input.expectedResult,
    actions: input.actions,
    userNote: input.userNote,
    improvementTitle: input.improvementTitle,
    observation: input.observation,
    links: input.links,
    evidenceCount: input.evidence.length,
    evidenceSummary: input.evidenceSummary,
    prdRequirements: input.prdRequirements,
    beadWorkAreas: input.beadWorkAreas,
    hasPrdRefs: Boolean(input.prdRefs?.length),
    hasBeadRefs: Boolean(input.beadRefs?.length),
  })
  return {
    description: composed.description,
    omittedCharacters: composed.omittedCharacters,
    omittedFields: composed.omittedFields,
  }
}

function humanReadableExcerpt(value: unknown, maxLength = 600): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1).trimEnd()}…`
}

function resolvePrdRequirements(ticketDir: string, refs: Array<{ ref: string }>): string[] {
  if (refs.length === 0) return []
  try {
    const raw = parseYamlOrJsonCandidate(readFileSync(resolve(ticketDir, 'prd.yaml'), 'utf8')) as {
      epics?: Array<{
        id?: unknown
        user_stories?: Array<{ id?: unknown; title?: unknown; acceptance_criteria?: unknown[] }>
      }>
    }
    const requirements: string[] = []
    for (const { ref } of refs) {
      const [epicId, storyId, criterionId] = ref.split('/')
      const epic = raw.epics?.find((entry) => entry.id === epicId)
      const story = epic?.user_stories?.find((entry) => entry.id === storyId)
      const criterionIndex = criterionId?.match(/^AC-(\d+)$/i)?.[1]
      const criterion = criterionIndex && story?.acceptance_criteria
        ? story.acceptance_criteria[Number(criterionIndex) - 1]
        : undefined
      const readable = humanReadableExcerpt(criterion) ?? humanReadableExcerpt(story?.title)
      if (readable && !requirements.includes(readable)) requirements.push(readable)
    }
    return requirements
  } catch {
    return []
  }
}

function resolveBeadWorkAreas(beads: Bead[], refs: string[]): string[] {
  const byId = new Map(beads.map((bead) => [bead.id, bead]))
  const workAreas: string[] = []
  for (const ref of refs) {
    const bead = byId.get(ref)
    if (!bead) continue
    const title = humanReadableExcerpt(bead.title, 240)
    const description = humanReadableExcerpt(bead.description)
    const targetFiles = (bead.targetFiles ?? []).slice(0, 8).join(', ')
    const readable = [title, description && description !== title ? description : null]
      .filter((value): value is string => Boolean(value))
      .join(' — ')
    const withFiles = `${readable}${targetFiles ? `${readable ? ' ' : ''}(files: ${targetFiles})` : ''}`.trim()
    if (withFiles && !workAreas.includes(withFiles)) workAreas.push(withFiles)
  }
  return workAreas
}

function summarizeImprovementEvidence(evidence: ManualQaEvidenceRef[]): string | undefined {
  if (evidence.length === 0) return undefined
  const imageCount = evidence.filter((entry) => entry.mediaType.toLowerCase().startsWith('image/')).length
  const otherCount = evidence.length - imageCount
  const categories = [
    imageCount ? `${imageCount} image${imageCount === 1 ? '' : 's'}` : '',
    otherCount ? `${otherCount} other file${otherCount === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' and ')
  return `${evidence.length} uploaded file${evidence.length === 1 ? '' : 's'} (${categories}) retained with the Manual QA origin metadata.`
}

function copyImprovementEvidence(input: {
  sourceTicketDir: string
  destinationTicketDir: string
  version: number
  itemId: string
  evidence: ManualQaEvidenceRef[]
}): { copied: QaOriginEvidenceRef[]; omitted: Array<{ id: string; reason: string }> } {
  const destinationDir = resolve(input.destinationTicketDir, 'origin', 'manual-qa', 'evidence')
  mkdirSync(destinationDir, { recursive: true })
  const copied: QaOriginEvidenceRef[] = []
  const omitted: Array<{ id: string; reason: string }> = []
  for (const evidence of input.evidence) {
    try {
      const source = resolveManualQaEvidence({
        ticketDir: input.sourceTicketDir,
        version: input.version,
        itemId: input.itemId,
        evidenceId: evidence.id,
      })
      if (lstatSync(source.path).isSymbolicLink()) throw new Error('symlink evidence is not allowed')
      // Sanitized, not just basename'd: storedName may carry characters Windows
      // rejects in filenames, such as the NTFS stream separator ':'.
      const destinationName = `${evidence.id}-${sanitizeEvidenceName(evidence.storedName)}`
      const destination = resolve(destinationDir, destinationName)
      cpSync(source.path, destination, { errorOnExist: false, force: true })
      const rawHash = createHash('sha256').update(readFileSync(destination)).digest('hex')
      if (rawHash !== evidence.sha256) throw new Error('hash mismatch')
      copied.push({
        id: evidence.id,
        originalName: evidence.originalName,
        mediaType: evidence.mediaType,
        size: evidence.size,
        sha256: evidence.sha256,
        relativePath: `origin/manual-qa/evidence/${destinationName}`,
      })
    } catch (error) {
      omitted.push({ id: evidence.id, reason: getErrorMessage(error) })
    }
  }
  return { copied, omitted }
}

function findExistingImprovement(projectId: number, originId: string): ReturnType<typeof listTickets>[number] | null {
  return listTickets(projectId).find((ticket) => {
    const paths = getTicketPaths(ticket.id)
    if (!paths) return false
    try {
      const raw = JSON.parse(readFileSync(resolve(paths.ticketDir, 'meta', 'manual-qa-origin.json'), 'utf8')) as unknown
      return Boolean(raw && typeof raw === 'object' && (raw as { originId?: unknown }).originId === originId)
    } catch {
      return false
    }
  }) ?? null
}

function createImprovementTicket(input: {
  sourceTicketId: string
  sourceExternalId: string
  sourceTicketDir: string
  projectId: number
  version: number
  actionId: string
  draft: ManualQaImprovementDraft
  item: ManualQaChecklist['items'][number]
  result: ManualQaItemResult
  evidence: ManualQaEvidenceRef[]
}): string {
  const originId = `manual-qa:${input.sourceExternalId}:v${input.version}:${input.draft.id}`
  const reservationPath = resolve(
    getManualQaStoragePaths(input.sourceTicketDir, input.version).versionDir,
    'improvement-operations',
    `${contentSha256Text(originId)}.json`,
  )
  let reservedTicketId: string | null = null
  if (existsSync(reservationPath)) {
    const reservation = JSON.parse(readFileSync(reservationPath, 'utf8')) as { originId?: unknown; ticketId?: unknown }
    if (reservation.originId !== originId || typeof reservation.ticketId !== 'string') {
      throw new Error(`Manual QA improvement reservation is invalid: ${originId}`)
    }
    reservedTicketId = reservation.ticketId
  }
  const existing = reservedTicketId ? getTicketByRef(reservedTicketId) : findExistingImprovement(input.projectId, originId)
  const sourceBeadsPath = getTicketPaths(input.sourceTicketId)?.beadsPath
  const sourceBeads = sourceBeadsPath && existsSync(sourceBeadsPath) ? readBeadsFile(sourceBeadsPath) : []
  const built = buildImprovementDescription({
    description: input.draft.description,
    contextOverride: input.draft.contextOverride,
    sourceExternalId: input.sourceExternalId,
    version: input.version,
    itemId: input.item.id,
    title: input.item.title,
    behavior: input.item.behavior,
    source: input.item.source,
    expectedResult: input.item.expectedResult,
    actions: input.item.actions,
    userNote: input.result.note,
    improvementTitle: input.draft.title,
    observation: input.result.observation,
    evidence: input.evidence,
    links: input.result.links,
    prdRefs: input.item.prdRefs.map((entry) => `${entry.ref} (${entry.coverage})`),
    beadRefs: input.item.beadRefs,
    prdRequirements: resolvePrdRequirements(input.sourceTicketDir, input.item.prdRefs),
    beadWorkAreas: resolveBeadWorkAreas(sourceBeads, input.item.beadRefs),
    evidenceSummary: summarizeImprovementEvidence(input.evidence),
  })
  const description = built.description
  const ticket = existing ?? createManualQaImprovementTicket({
    projectId: input.projectId,
    originId,
    actionId: input.actionId,
    title: input.draft.title,
    description,
    priority: input.draft.priority,
    manualQaEnabled: input.draft.manualQaEnabled,
  })
  if (ticket.priority !== input.draft.priority || ticket.manualQaOverride !== input.draft.manualQaEnabled) {
    throw new Error(`Manual QA improvement ticket settings conflict with the reserved draft: ${originId}`)
  }
  const destinationPaths = getTicketPaths(ticket.id)
  if (!destinationPaths) throw new Error(`Improvement ticket storage was not created: ${ticket.id}`)
  safeAtomicWrite(reservationPath, JSON.stringify({
    schemaVersion: MANUAL_QA_SCHEMA_VERSION,
    originId,
    actionId: input.actionId,
    ticketId: ticket.id,
    state: 'created',
    createdAt: ticket.createdAt,
  }, null, 2))
  const childOriginPath = resolve(destinationPaths.ticketDir, 'meta', 'manual-qa-origin.json')
  if (!existsSync(childOriginPath)) {
    safeAtomicWrite(childOriginPath, JSON.stringify({
      schemaVersion: MANUAL_QA_SCHEMA_VERSION,
      originId,
      actionId: input.actionId,
      state: 'repairing',
    }, null, 2))
  }
  const copied = copyImprovementEvidence({
    sourceTicketDir: input.sourceTicketDir,
    destinationTicketDir: destinationPaths.ticketDir,
    version: input.version,
    itemId: input.item.id,
    evidence: input.evidence,
  })
  const origin = ManualQaImprovementOriginSchema.parse({
    schemaVersion: MANUAL_QA_SCHEMA_VERSION,
    source: 'manual_qa_improvement',
    originId,
    actionId: input.actionId,
    sourceTicketId: input.sourceTicketId,
    sourceTicketExternalId: input.sourceExternalId,
    sourceProjectId: input.projectId,
    sourceVersion: input.version,
    sourceItemIds: [input.item.id],
    sourceItemTitles: [input.item.title],
    resultType: 'improvement',
    relatedPrdRefs: input.item.prdRefs.map((entry) => entry.ref),
    relatedBeadRefs: input.item.beadRefs,
    evidenceRefs: copied.copied,
    omittedEvidence: copied.omitted,
    titleSha256: contentSha256Text(input.draft.title),
    descriptionSha256: contentSha256Text(description),
    priority: input.draft.priority,
    manualQaEnabled: input.draft.manualQaEnabled,
    omittedFields: built.omittedFields,
    imageEvidenceMode: 'references_only',
    createdAt: ticket.createdAt,
  })
  safeAtomicWrite(childOriginPath, JSON.stringify(origin, null, 2))
  safeAtomicWrite(resolve(destinationPaths.ticketDir, 'origin', 'manual-qa', 'source-receipt.json'), JSON.stringify(origin, null, 2))
  return ticket.id
}

function contentSha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function resolveQaModelCapability(input: {
  ticketId: string
  version: number
  modelId: string | null | undefined
  modelVariant: string | null | undefined
}): Promise<ManualQaModelCapabilitySnapshot> {
  const capturedAt = new Date().toISOString()
  if (!input.modelId) return {
    schemaVersion: MANUAL_QA_SCHEMA_VERSION,
    artifact: 'manual_qa_model_capability',
    ticketId: input.ticketId,
    version: input.version,
    modelId: null,
    modelVariant: input.modelVariant?.trim() || null,
    capabilityLookup: 'unavailable',
    supportsImages: null,
    imageEvidenceMode: 'references_only',
    capturedAt,
  }
  try {
    const catalog = await fetchProviderCatalog()
    const selected = flattenCatalogModels(catalog, 'all').find((model) => model.fullId === input.modelId)
    const supportsImages = selected?.canSeeImages ?? false
    return {
      schemaVersion: MANUAL_QA_SCHEMA_VERSION,
      artifact: 'manual_qa_model_capability',
      ticketId: input.ticketId,
      version: input.version,
      modelId: input.modelId,
      modelVariant: input.modelVariant?.trim() || null,
      capabilityLookup: selected ? 'available' : 'unavailable',
      supportsImages: selected ? supportsImages : null,
      imageEvidenceMode: selected && supportsImages ? 'attached' : 'references_only',
      capturedAt,
    }
  } catch {
    return {
      schemaVersion: MANUAL_QA_SCHEMA_VERSION,
      artifact: 'manual_qa_model_capability',
      ticketId: input.ticketId,
      version: input.version,
      modelId: input.modelId,
      modelVariant: input.modelVariant?.trim() || null,
      capabilityLookup: 'unavailable',
      supportsImages: null,
      imageEvidenceMode: 'references_only',
      capturedAt,
    }
  }
}

function buildManualQaSummary(input: {
  checklist: ManualQaChecklist
  draft: ManualQaDraft
  evidence: ManualQaEvidenceRef[]
  outcome: ManualQaSummary['outcome']
  createdFixBeadIds: string[]
  improvementTicketIds: string[]
  completedAt: string
  skipReason?: string
  modelCapability: ManualQaModelCapabilitySnapshot | null
  coverage: ReturnType<typeof readManualQaCoverage>
}): ManualQaSummary {
  const resultByItemId = new Map(input.draft.results.map((result) => [result.itemId, result]))
  const itemCounts = { pass: 0, fail: 0, waive: 0, improvement: 0, pending: 0 }
  for (const item of input.checklist.items) {
    const outcome = resultByItemId.get(item.id)?.outcome ?? 'pending'
    itemCounts[outcome] += 1
  }
  const waivedItems = input.draft.results
    .filter((result) => result.outcome === 'waive')
    .map((result) => ({ itemId: result.itemId, reason: result.reason.trim() }))
  const startedAt = input.checklist.generatedAt
  return {
    schemaVersion: MANUAL_QA_SCHEMA_VERSION,
    artifact: 'manual_qa_summary',
    ticketId: input.checklist.ticketId,
    version: input.checklist.version,
    outcome: input.outcome,
    createdFixBeadIds: input.createdFixBeadIds,
    improvementTicketIds: input.improvementTicketIds,
    waivedItemIds: waivedItems.map((item) => item.itemId),
    waivedItems,
    ...(input.skipReason?.trim() ? { skipReason: input.skipReason.trim() } : {}),
    startedAt,
    completedAt: input.completedAt,
    durationMs: Math.max(0, Date.parse(input.completedAt) - Date.parse(startedAt)),
    itemCounts,
    requiredItemCount: input.checklist.items.filter((item) => item.severity === 'required').length,
    optionalItemCount: input.checklist.items.filter((item) => item.severity === 'optional').length,
    evidenceCount: input.evidence.length,
    nextAction: input.outcome === 'failed' || input.outcome === 'created_fixes' ? 'return_to_coding' : 'integrate',
    coverage: {
      covered: input.coverage?.coveredCount ?? 0,
      partiallyCovered: input.coverage?.partiallyCoveredCount ?? 0,
      uncovered: input.coverage?.uncoveredCount ?? 0,
      notApplicable: input.coverage?.notApplicableCount ?? 0,
    },
    modelCapability: input.modelCapability,
  }
}

function appendManualQaSummaryEvent(ticketDir: string, summary: ManualQaSummary, actionId: string): void {
  const skipped = summary.outcome === 'skipped'
  appendManualQaEvent(ticketDir, {
    schemaVersion: MANUAL_QA_SCHEMA_VERSION,
    eventId: deterministicId(`${skipped ? 'skipped' : 'completed'}-v${summary.version}`, skipped ? actionId : summary.outcome),
    eventType: skipped ? 'skipped' : 'completed',
    ticketId: summary.ticketId,
    version: summary.version,
    actionId,
    createdAt: summary.completedAt,
    data: skipped
      ? { reason: summary.skipReason ?? '' }
      : { outcome: summary.outcome, nextAction: summary.nextAction },
  })
}

function persistSummaryArtifact(ticketId: string, summary: ManualQaSummary): void {
  persistManualQaPhaseArtifact(ticketId, 'manual_qa_summary', summary, `${summary.version}:${summary.outcome}`)
}

function repairTerminalManualQaArtifacts(input: {
  ticketId: string
  ticketDir: string
  summary: ManualQaSummary
  actionId: string
}): void {
  persistSummaryArtifact(input.ticketId, input.summary)
  if (input.summary.outcome !== 'skipped') return

  const skipReceiptPath = getManualQaStoragePaths(input.ticketDir, input.summary.version).skipReceiptPath
  if (!existsSync(skipReceiptPath)) {
    throw new Error('Canonical Manual QA skip receipt is missing during recovery.')
  }
  const parsed = parseYamlOrJsonCandidate(readFileSync(skipReceiptPath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Canonical Manual QA skip receipt is invalid during recovery.')
  }
  const receipt = parsed as Record<string, unknown>
  if (
    receipt.artifact !== 'manual_qa_skip_receipt'
    || receipt.version !== input.summary.version
    || typeof receipt.actionId !== 'string'
    || !receipt.actionId.trim()
  ) {
    throw new Error('Canonical Manual QA skip receipt does not match the durable summary.')
  }
  if (input.actionId && receipt.actionId !== input.actionId) {
    throw new Error('Canonical Manual QA skip receipt does not match the recovery operation.')
  }
  persistManualQaPhaseArtifact(
    input.ticketId,
    'manual_qa_skip_receipt',
    receipt,
    receipt.actionId,
  )
}

function persistManualQaPhaseArtifact(ticketId: string, artifactType: string, value: unknown, idempotencyKey: string): void {
  const existing = getLatestPhaseArtifact(ticketId, artifactType, 'WAITING_MANUAL_QA')
  if (existing?.content.includes(`"idempotencyKey":"${idempotencyKey}"`)) return
  const content = value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>), idempotencyKey }
    : { idempotencyKey, value }
  insertPhaseArtifact(ticketId, {
    phase: 'WAITING_MANUAL_QA',
    phaseAttempt: resolvePhaseAttempt(ticketId, 'WAITING_MANUAL_QA'),
    artifactType,
    content: JSON.stringify(content),
  })
}

const QA_RESTART_PHASES = ['RUNNING_FINAL_TEST', 'GENERATING_QA_CHECKLIST', 'WAITING_MANUAL_QA'] as const

function captureOperationSourceAttempts(ticketId: string, journal: ManualQaOperationJournal): boolean {
  if (journal.sourcePhaseAttempts) return false
  // Materialize attempt rows before recording their numbers. A synthetic
  // default attempt (`1`) cannot later be distinguished from the first fresh
  // row created for QA fixes, which would make recovery archive twice.
  createFreshPhaseAttempts(ticketId, QA_RESTART_PHASES)
  journal.sourcePhaseAttempts = Object.fromEntries(
    QA_RESTART_PHASES.map((phase) => [phase, resolvePhaseAttempt(ticketId, phase)]),
  )
  return true
}

function prepareQaFixWorkflow(ticketId: string, journal: ManualQaOperationJournal): void {
  const beadsPath = getTicketPaths(ticketId)?.beadsPath
  if (!beadsPath) throw new Error(`Ticket storage was not found: ${ticketId}`)
  const beads = readBeadsFile(beadsPath)
  const completed = beads.filter((bead) => bead.status === 'done').length
  const currentBead = beads.length === 0 ? 0 : completed >= beads.length ? beads.length : completed + 1
  patchTicket(ticketId, {
    totalBeads: beads.length,
    currentBead,
    percentComplete: beads.length === 0 ? 0 : Math.round((completed / beads.length) * 100),
  })
  for (const phase of QA_RESTART_PHASES) {
    const sourceAttempt = journal.sourcePhaseAttempts?.[phase]
    const activeAttempt = listPhaseAttempts(ticketId, phase).find((attempt) => attempt.state === 'active')
    if (sourceAttempt !== undefined && activeAttempt && activeAttempt.attemptNumber > sourceAttempt) continue
    archiveActivePhaseAttempts(ticketId, [phase], 'manual_qa_fixes_created')
    createFreshPhaseAttempts(ticketId, [phase])
  }
}

function dispatchCompletedManualQaWorkflow(input: {
  ticketId: string
  summary: ManualQaSummary
  journal?: ManualQaOperationJournal | null
  sendEvent: (event: TicketEvent) => void
}): void {
  // A durable summary is written before the state-machine transition. Retried
  // requests must finish that last step, but must not send an obsolete event
  // after a prior request already moved the ticket out of Manual QA.
  if (getTicketByRef(input.ticketId)?.status !== 'WAITING_MANUAL_QA') return
  if (input.summary.outcome === 'failed') return
  if (input.summary.outcome === 'created_fixes') {
    const journal = input.journal ?? {
      schemaVersion: MANUAL_QA_SCHEMA_VERSION,
      actionId: 'manual-qa-recovery',
      operationType: 'submit',
      ticketId: input.ticketId,
      version: input.summary.version,
      checklistHash: '',
      draftRevision: 0,
      state: 'complete',
      improvementTicketIds: input.summary.improvementTicketIds,
      fixBeadIds: input.summary.createdFixBeadIds,
      sourcePhaseAttempts: Object.fromEntries(
        QA_RESTART_PHASES.map((phase) => [phase, resolvePhaseAttempt(input.ticketId, phase)]),
      ),
      createdAt: input.summary.completedAt,
      updatedAt: input.summary.completedAt,
    } satisfies ManualQaOperationJournal
    prepareQaFixWorkflow(input.ticketId, journal)
  }
  input.sendEvent({
    type: input.summary.outcome === 'created_fixes'
      ? 'MANUAL_QA_FIXES_CREATED'
      : input.summary.outcome === 'skipped'
        ? 'MANUAL_QA_SKIPPED'
        : 'MANUAL_QA_COMPLETE',
  })
}

function finalizeRecoveredOperation(
  ticketId: string,
  operationPath: string,
  journal: ManualQaOperationJournal | null,
  summary: ManualQaSummary,
): void {
  if (!journal || journal.state === 'complete') return
  if (journal.ticketId !== ticketId || journal.version !== summary.version) {
    throw new Error('Manual QA operation journal does not match the durable summary.')
  }
  journal.state = 'complete'
  journal.updatedAt = summary.completedAt
  writeJournal(operationPath, journal)
  persistManualQaDatabaseOperation(ticketId, journal)
}

export async function submitManualQa(input: {
  ticketId: string
  version: number
  draft: ManualQaDraft
  guard: ManualQaMutationGuard
  sendEvent: (event: TicketEvent) => void
  signal?: AbortSignal
  generateFixBeads?: (input: GenerateManualQaFixBeadsInput) => Promise<ManualQaFixBeadCandidate[]>
}): Promise<ManualQaSummary> {
  const ticket = getTicketByRef(input.ticketId)
  const paths = getTicketPaths(input.ticketId)
  if (!ticket || !paths) throw new Error(`Ticket was not found: ${input.ticketId}`)
  const existingSummary = readManualQaSummary(paths.ticketDir, input.version)
  const operationPath = getManualQaStoragePaths(paths.ticketDir, input.version).operationPath
  if (existingSummary && existingSummary.outcome !== 'failed') {
    const existingJournal = existsSync(operationPath)
      ? JSON.parse(readFileSync(operationPath, 'utf8')) as ManualQaOperationJournal
      : null
    const recoveryActionId = existingJournal?.actionId ?? `manual-qa-recovery-v${input.version}`
    finalizeRecoveredOperation(input.ticketId, operationPath, existingJournal, existingSummary)
    repairTerminalManualQaArtifacts({
      ticketId: input.ticketId,
      ticketDir: paths.ticketDir,
      summary: existingSummary,
      actionId: recoveryActionId,
    })
    appendManualQaSummaryEvent(paths.ticketDir, existingSummary, recoveryActionId)
    dispatchCompletedManualQaWorkflow({
      ticketId: input.ticketId,
      summary: existingSummary,
      journal: existingJournal,
      sendEvent: input.sendEvent,
    })
    return existingSummary
  }
  const parsedDraft = ManualQaDraftSchema.parse(input.draft)
  assertMutationGuard(input.ticketId, paths.ticketDir, input.version, parsedDraft, input.guard)
  const checklist = readManualQaChecklist(paths.ticketDir, input.version)
  if (!checklist) throw new Error('Manual QA checklist was not found.')
  const evidence = readManualQaEvidenceIndex(paths.ticketDir, input.version)
  const draft = canonicalizeSubmissionEvidence(checklist, parsedDraft, evidence)
  validateSubmission(checklist, draft, evidence)
  emitManualQaOperationMilestone(
    input.ticketId,
    ticket.externalId,
    `Validated Manual QA submission for v${input.version}.`,
    `${input.guard.actionId}:validated`,
  )
  const drift = detectManualQaWorkspaceDrift(input.ticketId, input.version)
  if (drift.drifted) {
    const error = new Error('Manual QA workspace changed during user verification; include or discard audited files before submitting.')
    Object.assign(error, { code: 'MANUAL_QA_WORKSPACE_DRIFT', drift })
    throw error
  }

  // Reserve and validate the durable operation before writing immutable
  // snapshots. Conflicting retries must not modify canonical results first.
  const journal = reserveManualQaSubmissionOperation({
    path: operationPath,
    actionId: input.guard.actionId,
    operationType: 'submit',
    ticketId: input.ticketId,
    version: input.version,
    checklistHash: input.guard.expectedChecklistHash,
    draftRevision: input.guard.expectedDraftRevision,
  })
  if (captureOperationSourceAttempts(input.ticketId, journal)) {
    journal.updatedAt = new Date().toISOString()
    writeJournal(operationPath, journal)
  }
  persistManualQaDatabaseOperation(input.ticketId, journal)
  const operationActionId = journal.actionId

  snapshotManualQaDraft(paths.ticketDir, draft)
  const existingResults = readManualQaResults(paths.ticketDir, input.version)
  let results: ManualQaResults
  if (existingResults) {
    const { artifact: _existingArtifact, actionId, submittedAt: _submittedAt, ...existingDraft } = existingResults
    const { artifact: _draftArtifact, ...draftValue } = draft
    if (actionId !== operationActionId || JSON.stringify(existingDraft) !== JSON.stringify(draftValue)) {
      throw new Error('Canonical Manual QA results conflict with the reserved submission operation.')
    }
    results = existingResults
  } else {
    results = {
      ...draft,
      artifact: 'manual_qa_results',
      actionId: operationActionId,
      submittedAt: new Date().toISOString(),
    }
    persistManualQaResults(paths.ticketDir, results)
  }
  persistManualQaPhaseArtifact(input.ticketId, 'manual_qa_draft', draft, operationActionId)
  persistManualQaPhaseArtifact(input.ticketId, 'manual_qa_results', results, operationActionId)
  persistManualQaPhaseArtifact(input.ticketId, 'manual_qa_submission_idempotency', {
    actionId: operationActionId,
    version: input.version,
    checklistHash: input.guard.expectedChecklistHash,
    draftRevision: input.guard.expectedDraftRevision,
  }, operationActionId)
  appendManualQaEvent(paths.ticketDir, {
    schemaVersion: MANUAL_QA_SCHEMA_VERSION,
    eventId: deterministicId(`submission-v${input.version}`, operationActionId),
    eventType: 'draft_submitted',
    ticketId: ticket.externalId,
    version: input.version,
    actionId: operationActionId,
    createdAt: journal.createdAt,
    data: { draftRevision: journal.draftRevision, checklistHash: journal.checklistHash },
  })

  const failed = draft.results.filter((result) => result.outcome === 'fail')
  const modelCapability = readManualQaModelCapabilitySnapshot(paths.ticketDir, input.version)
    ?? await resolveQaModelCapability({
      ticketId: ticket.externalId,
      version: input.version,
      modelId: ticket.lockedMainImplementer,
      modelVariant: ticket.lockedMainImplementerVariant,
    })
  persistManualQaModelCapabilitySnapshot(paths.ticketDir, modelCapability)
  const coverage = readManualQaCoverage(paths.ticketDir, input.version)
  if (failed.length > 0 && existingSummary?.outcome !== 'failed') {
    const intermediate = buildManualQaSummary({
      checklist,
      draft,
      evidence,
      outcome: 'failed',
      createdFixBeadIds: [],
      improvementTicketIds: [],
      completedAt: new Date().toISOString(),
      modelCapability,
      coverage,
    })
    persistManualQaSummary(paths.ticketDir, intermediate)
    persistSummaryArtifact(input.ticketId, intermediate)
  }

  const existingBeads = readBeadsFile(paths.beadsPath)
  const fixGroups = buildManualQaFixGroups(checklist, draft)
  let fixBeads: Bead[] = []
  if (fixGroups.length > 0) {
    journal.state = 'generating_beads'
    journal.updatedAt = new Date().toISOString()
    writeJournal(operationPath, journal)
    persistManualQaDatabaseOperation(input.ticketId, journal)
    try {
      const storedCandidates = readManualQaFixBeadCandidates(paths.ticketDir, input.version, fixGroups)
      const candidates = storedCandidates ?? await (input.generateFixBeads ?? generateManualQaFixBeadCandidates)({
        ticketId: input.ticketId,
        context: buildTicketContextFromTicket(ticket),
        checklist,
        draft,
        evidence,
        existingBeads,
        signal: input.signal,
      })
      const candidateContent = persistManualQaFixBeadCandidates(paths.ticketDir, input.version, candidates)
      persistManualQaPhaseArtifact(
        input.ticketId,
        'manual_qa_fix_beads',
        { version: input.version, content: candidateContent },
        operationActionId,
      )
      fixBeads = hydrateManualQaFixBeads({
        candidates,
        groups: fixGroups,
        existing: existingBeads,
        checklist,
        evidence,
        ticketId: input.ticketId,
        externalId: ticket.externalId,
        version: input.version,
        actionId: operationActionId,
        modelCapability,
      })
      journal.fixBeadIds = fixBeads.map((bead) => bead.id)
      journal.updatedAt = new Date().toISOString()
      writeJournal(operationPath, journal)
      persistManualQaDatabaseOperation(input.ticketId, journal)
    } catch (error) {
      const message = getErrorMessage(error)
      emitPhaseLog(input.ticketId, ticket.externalId, 'WAITING_MANUAL_QA', 'error', `Manual QA fix-bead generation failed: ${message}`, {
        source: 'system',
        phaseAttempt: resolvePhaseAttempt(input.ticketId, 'WAITING_MANUAL_QA'),
      })
      input.sendEvent({ type: 'ERROR', message: `Manual QA fix-bead generation failed: ${message}`, codes: ['MANUAL_QA_FIX_BEADS_FAILED'] })
      throw error
    }
  }

  const itemById = new Map(checklist.items.map((item) => [item.id, item]))
  journal.state = 'creating_improvements'
  journal.updatedAt = new Date().toISOString()
  writeJournal(operationPath, journal)
  persistManualQaDatabaseOperation(input.ticketId, journal)
  for (const result of draft.results.filter((entry) => entry.outcome === 'improvement')) {
    const improvement = draft.improvements.find((entry) => entry.id === result.improvementDraftId)!
    const ticketId = createImprovementTicket({
      sourceTicketId: input.ticketId,
      sourceExternalId: ticket.externalId,
      sourceTicketDir: paths.ticketDir,
      projectId: ticket.projectId,
      version: input.version,
      actionId: operationActionId,
      draft: improvement,
      item: itemById.get(result.itemId)!,
      result,
      evidence: evidenceForIds(evidence, improvement.evidenceIds),
    })
    if (!journal.improvementTicketIds.includes(ticketId)) {
      journal.improvementTicketIds.push(ticketId)
      journal.updatedAt = new Date().toISOString()
      writeJournal(operationPath, journal)
      persistManualQaDatabaseOperation(input.ticketId, journal)
    }
    emitManualQaOperationMilestone(
      input.ticketId,
      ticket.externalId,
      `Created Improvement ticket ${getTicketByRef(ticketId)?.externalId ?? ticketId} with P${improvement.priority} and Manual QA ${improvement.manualQaEnabled ? 'enabled' : 'disabled'}.`,
      `${operationActionId}:improvement:${ticketId}`,
    )
  }
  const improvementCreations = journal.improvementTicketIds.map((ticketId) => {
    const childPaths = getTicketPaths(ticketId)
    if (!childPaths) throw new Error(`Improvement ticket storage was not found while writing its source receipt: ${ticketId}`)
    const origin = ManualQaImprovementOriginSchema.parse(JSON.parse(
      readFileSync(resolve(childPaths.ticketDir, 'meta', 'manual-qa-origin.json'), 'utf8'),
    ) as unknown)
    return {
      ticketId,
      sourceItemIds: origin.sourceItemIds,
      titleSha256: origin.titleSha256,
      descriptionSha256: origin.descriptionSha256,
      copiedEvidence: origin.evidenceRefs.map((entry) => ({ id: entry.id, sha256: entry.sha256 })),
      omittedEvidence: origin.omittedEvidence,
      omittedFields: origin.omittedFields,
      priority: origin.priority,
      manualQaEnabled: origin.manualQaEnabled,
      createdAt: origin.createdAt,
    }
  })
  const improvementReceipt = {
    schemaVersion: MANUAL_QA_SCHEMA_VERSION,
    actionId: operationActionId,
    version: input.version,
    ticketIds: journal.improvementTicketIds,
    tickets: improvementCreations,
    createdAt: new Date().toISOString(),
  }
  safeAtomicWrite(getManualQaStoragePaths(paths.ticketDir, input.version).improvementTicketReceiptPath, JSON.stringify(improvementReceipt, null, 2))
  persistManualQaPhaseArtifact(input.ticketId, 'manual_qa_improvement_ticket_receipt', improvementReceipt, operationActionId)
  for (const creation of improvementCreations) {
    appendManualQaEvent(paths.ticketDir, {
      schemaVersion: MANUAL_QA_SCHEMA_VERSION,
      eventId: deterministicId(`improvement-v${input.version}`, creation.ticketId),
      eventType: 'improvement_created',
      ticketId: ticket.externalId,
      version: input.version,
      actionId: operationActionId,
      createdAt: creation.createdAt,
      data: {
        ticketId: creation.ticketId,
        sourceItemIds: creation.sourceItemIds,
        priority: creation.priority,
        manualQaEnabled: creation.manualQaEnabled,
      },
    })
  }

  journal.state = 'creating_beads'
  journal.updatedAt = new Date().toISOString()
  writeJournal(operationPath, journal)
  persistManualQaDatabaseOperation(input.ticketId, journal)
  if (fixBeads.length > 0) {
    const existingIds = new Set(existingBeads.map((bead) => bead.id))
    writeJsonl(paths.beadsPath, [...existingBeads, ...fixBeads.filter((bead) => !existingIds.has(bead.id))])
    for (const bead of fixBeads) {
      emitManualQaOperationMilestone(
        input.ticketId,
        ticket.externalId,
        `Created QA fix bead ${bead.id}: ${bead.title}`,
        `${operationActionId}:bead:${bead.id}`,
      )
    }
  }

  const beadReceipt = {
    schemaVersion: MANUAL_QA_SCHEMA_VERSION,
    actionId: operationActionId,
    version: input.version,
    beadIds: journal.fixBeadIds,
    createdAt: new Date().toISOString(),
  }
  safeAtomicWrite(getManualQaStoragePaths(paths.ticketDir, input.version).beadCreationReceiptPath, JSON.stringify(beadReceipt, null, 2))
  persistManualQaPhaseArtifact(input.ticketId, 'manual_qa_bead_creation_receipt', beadReceipt, operationActionId)
  if (journal.fixBeadIds.length > 0) {
    appendManualQaEvent(paths.ticketDir, {
      schemaVersion: MANUAL_QA_SCHEMA_VERSION,
      eventId: deterministicId(`fixes-v${input.version}`, operationActionId),
      eventType: 'fixes_created',
      ticketId: ticket.externalId,
      version: input.version,
      actionId: operationActionId,
      createdAt: beadReceipt.createdAt,
      data: { beadIds: journal.fixBeadIds },
    })
  }

  const waivedItemIds = draft.results.filter((result) => result.outcome === 'waive').map((result) => result.itemId)
  const requiredWaivers = waivedItemIds.filter((itemId) => itemById.get(itemId)?.severity === 'required')
  const summary = buildManualQaSummary({
    checklist,
    draft,
    evidence,
    outcome: failed.length > 0 ? 'created_fixes' : requiredWaivers.length > 0 ? 'waived_through' : 'passed',
    createdFixBeadIds: journal.fixBeadIds,
    improvementTicketIds: journal.improvementTicketIds,
    completedAt: new Date().toISOString(),
    modelCapability,
    coverage,
  })
  persistManualQaSummary(paths.ticketDir, summary)
  persistSummaryArtifact(input.ticketId, summary)
  appendManualQaSummaryEvent(paths.ticketDir, summary, operationActionId)
  journal.state = 'complete'
  journal.updatedAt = new Date().toISOString()
  writeJournal(operationPath, journal)
  persistManualQaDatabaseOperation(input.ticketId, journal)
  dispatchCompletedManualQaWorkflow({
    ticketId: input.ticketId,
    summary,
    journal,
    sendEvent: input.sendEvent,
  })
  emitManualQaOperationMilestone(
    input.ticketId,
    ticket.externalId,
    `Manual QA v${input.version} completed with outcome ${summary.outcome}.`,
    `${operationActionId}:complete`,
  )
  return summary
}

export async function skipManualQa(input: {
  ticketId: string
  version: number
  draft: ManualQaDraft
  guard: ManualQaMutationGuard
  reason?: string
  sendEvent: (event: TicketEvent) => void
}): Promise<ManualQaSummary> {
  const ticket = getTicketByRef(input.ticketId)
  const ticketDir = resolveManualQaTicketDir(input.ticketId)
  if (!ticket) throw new Error(`Ticket was not found: ${input.ticketId}`)
  const operationPath = getManualQaStoragePaths(ticketDir, input.version).operationPath
  const existing = readManualQaSummary(ticketDir, input.version)
  if (existing && existing.outcome !== 'failed') {
    const existingJournal = existsSync(operationPath)
      ? JSON.parse(readFileSync(operationPath, 'utf8')) as ManualQaOperationJournal
      : null
    const recoveryActionId = existingJournal?.actionId ?? `manual-qa-recovery-v${input.version}`
    finalizeRecoveredOperation(input.ticketId, operationPath, existingJournal, existing)
    repairTerminalManualQaArtifacts({
      ticketId: input.ticketId,
      ticketDir,
      summary: existing,
      actionId: recoveryActionId,
    })
    appendManualQaSummaryEvent(ticketDir, existing, recoveryActionId)
    dispatchCompletedManualQaWorkflow({
      ticketId: input.ticketId,
      summary: existing,
      journal: existingJournal,
      sendEvent: input.sendEvent,
    })
    return existing
  }
  const draft = ManualQaDraftSchema.parse(input.draft)
  assertMutationGuard(input.ticketId, ticketDir, input.version, draft, input.guard)
  const drift = detectManualQaWorkspaceDrift(input.ticketId, input.version)
  if (drift.drifted) {
    const error = new Error('Manual QA workspace changed during user verification; include or discard audited files before skipping.')
    Object.assign(error, { code: 'MANUAL_QA_WORKSPACE_DRIFT', drift })
    throw error
  }
  const now = new Date().toISOString()
  const journal = reserveManualQaSubmissionOperation({
    path: operationPath,
    actionId: input.guard.actionId,
    operationType: 'skip',
    ticketId: input.ticketId,
    version: input.version,
    checklistHash: input.guard.expectedChecklistHash,
    draftRevision: input.guard.expectedDraftRevision,
  })
  captureOperationSourceAttempts(input.ticketId, journal)
  journal.updatedAt = now
  writeJournal(operationPath, journal)
  persistManualQaDatabaseOperation(input.ticketId, journal)
  const operationActionId = journal.actionId
  const checklist = readManualQaChecklist(ticketDir, input.version)
  if (!checklist) throw new Error('Manual QA checklist was not found.')
  const evidence = readManualQaEvidenceIndex(ticketDir, input.version)

  snapshotManualQaDraft(ticketDir, draft)
  persistManualQaPhaseArtifact(input.ticketId, 'manual_qa_draft', draft, operationActionId)
  safeAtomicWrite(getManualQaStoragePaths(ticketDir, input.version).skipReceiptPath, [
    `schemaVersion: ${MANUAL_QA_SCHEMA_VERSION}`,
    'artifact: manual_qa_skip_receipt',
    `ticketId: ${JSON.stringify(ticket.externalId)}`,
    `version: ${input.version}`,
    `actionId: ${JSON.stringify(operationActionId)}`,
    `reason: ${JSON.stringify(input.reason ?? '')}`,
    `createdAt: ${JSON.stringify(now)}`,
    '',
  ].join('\n'))
  const modelCapability = readManualQaModelCapabilitySnapshot(ticketDir, input.version)
    ?? await resolveQaModelCapability({
      ticketId: ticket.externalId,
      version: input.version,
      modelId: ticket.lockedMainImplementer,
      modelVariant: ticket.lockedMainImplementerVariant,
    })
  persistManualQaModelCapabilitySnapshot(ticketDir, modelCapability)
  const summary = buildManualQaSummary({
    checklist,
    draft,
    evidence,
    outcome: 'skipped',
    createdFixBeadIds: [],
    improvementTicketIds: [],
    skipReason: input.reason,
    completedAt: now,
    modelCapability,
    coverage: readManualQaCoverage(ticketDir, input.version),
  })
  persistManualQaSummary(ticketDir, summary)
  persistManualQaPhaseArtifact(input.ticketId, 'manual_qa_skip_receipt', {
    actionId: operationActionId,
    version: input.version,
    // `null`, not `''`. "No reason given" and "an empty reason" are the same
    // fact, and the shared skip trail stores that fact one way. The canonical
    // `skip-receipt.yaml` and `events.jsonl` keep their existing shape — they
    // are the crash-recovery contract, not an audit surface.
    reason: input.reason?.trim() || null,
    createdAt: now,
  }, operationActionId)
  persistSummaryArtifact(input.ticketId, summary)
  appendManualQaSummaryEvent(ticketDir, summary, operationActionId)
  journal.state = 'complete'
  journal.updatedAt = new Date().toISOString()
  writeJournal(operationPath, journal)
  persistManualQaDatabaseOperation(input.ticketId, journal)
  dispatchCompletedManualQaWorkflow({
    ticketId: input.ticketId,
    summary,
    journal,
    sendEvent: input.sendEvent,
  })
  return summary
}
