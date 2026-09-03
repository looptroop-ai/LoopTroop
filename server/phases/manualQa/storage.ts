import { createHash, randomUUID } from 'node:crypto'
import {
  constants as fsConstants,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import * as jsYaml from 'js-yaml'
import { safeAtomicWrite } from '../../io/atomicWrite'
import { withFileLock } from '../../io/fileLock'
import { appendJsonl, readJsonl } from '../../io/jsonl'
import { buildYamlDocument } from '../../structuredOutput/yamlUtils'
import { contentSha256 } from '../../lib/contentHash'
import { getTicketPaths, listPhaseArtifacts, listPhaseAttempts } from '../../storage/tickets'
import {
  MANUAL_QA_SCHEMA_VERSION,
  MAX_MANUAL_QA_EVIDENCE_BYTES,
  ManualQaChecklistSchema,
  ManualQaCoverageSchema,
  ManualQaDraftSchema,
  ManualQaEvidenceRefSchema,
  ManualQaEventSchema,
  ManualQaModelCapabilitySnapshotSchema,
  ManualQaResultsSchema,
  ManualQaSummarySchema,
  type ManualQaChecklist,
  type ManualQaCoverage,
  type ManualQaDraft,
  type ManualQaEvidenceRef,
  type ManualQaEvent,
  type ManualQaGenerationReservation,
  type ManualQaResults,
  type ManualQaModelCapabilitySnapshot,
  type ManualQaSummary,
  type ManualQaVersionIndexEntry,
} from './types'

const SAFE_RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])

export interface ManualQaStoragePaths {
  root: string
  versionDir: string
  checklistPath: string
  resultsPath: string
  summaryPath: string
  coveragePath: string
  skipReceiptPath: string
  operationPath: string
  beadCreationReceiptPath: string
  fixBeadsPath: string
  improvementTicketReceiptPath: string
  evidenceDir: string
  evidenceIndexPath: string
  reservationPath: string
  baselinePath: string
  modelCapabilityPath: string
  eventsPath: string
}

function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) throw new Error('Manual QA version must be a positive integer.')
}

export function getManualQaStoragePaths(ticketDir: string, version: number): ManualQaStoragePaths {
  assertVersion(version)
  const root = resolve(ticketDir, 'manual-qa')
  const versionDir = resolve(root, `v${version}`)
  return {
    root,
    versionDir,
    checklistPath: resolve(versionDir, 'checklist.yaml'),
    resultsPath: resolve(versionDir, 'results.yaml'),
    summaryPath: resolve(versionDir, 'summary.yaml'),
    coveragePath: resolve(versionDir, 'coverage.yaml'),
    skipReceiptPath: resolve(versionDir, 'skip-receipt.yaml'),
    operationPath: resolve(versionDir, 'submission-operation.json'),
    beadCreationReceiptPath: resolve(versionDir, 'bead-creation-receipt.yaml'),
    fixBeadsPath: resolve(versionDir, 'fix-beads.yaml'),
    improvementTicketReceiptPath: resolve(versionDir, 'improvement-ticket-receipt.yaml'),
    evidenceDir: resolve(versionDir, 'evidence'),
    evidenceIndexPath: resolve(versionDir, 'evidence', 'index.json'),
    reservationPath: resolve(root, `generation-reservation-v${version}.json`),
    baselinePath: resolve(root, `workspace-baseline-v${version}.json`),
    modelCapabilityPath: resolve(versionDir, 'model-capability.json'),
    eventsPath: resolve(root, 'events.jsonl'),
  }
}

export function resolveManualQaTicketDir(ticketId: string): string {
  const paths = getTicketPaths(ticketId)
  if (!paths) throw new Error(`Ticket storage was not found: ${ticketId}`)
  return paths.ticketDir
}

function writeYaml(path: string, value: unknown): void {
  safeAtomicWrite(path, buildYamlDocument(value))
}

function readYaml<T>(path: string, parser: { parse(value: unknown): T }): T | null {
  if (!existsSync(path)) return null
  return parser.parse(jsYaml.load(readFileSync(path, 'utf8')))
}

export function persistManualQaChecklist(ticketDir: string, checklist: ManualQaChecklist): string {
  const parsed = ManualQaChecklistSchema.parse(checklist)
  const path = getManualQaStoragePaths(ticketDir, parsed.version).checklistPath
  writeYaml(path, parsed)
  return contentSha256(readFileSync(path, 'utf8'))
}

export function readManualQaChecklist(ticketDir: string, version: number): ManualQaChecklist | null {
  return readYaml(getManualQaStoragePaths(ticketDir, version).checklistPath, ManualQaChecklistSchema)
}

export function getManualQaChecklistHash(ticketDir: string, version: number): string | null {
  const path = getManualQaStoragePaths(ticketDir, version).checklistPath
  return existsSync(path) ? contentSha256(readFileSync(path, 'utf8')) : null
}

export function persistManualQaCoverage(ticketDir: string, coverage: ManualQaCoverage): void {
  const parsed = ManualQaCoverageSchema.parse(coverage)
  writeYaml(getManualQaStoragePaths(ticketDir, parsed.version).coveragePath, parsed)
}

export function readManualQaCoverage(ticketDir: string, version: number): ManualQaCoverage | null {
  return readYaml(getManualQaStoragePaths(ticketDir, version).coveragePath, ManualQaCoverageSchema)
}

export function persistManualQaResults(ticketDir: string, results: ManualQaResults): void {
  const parsed = ManualQaResultsSchema.parse(results)
  writeYaml(getManualQaStoragePaths(ticketDir, parsed.version).resultsPath, parsed)
}

export function readManualQaResults(ticketDir: string, version: number): ManualQaResults | null {
  return readYaml(getManualQaStoragePaths(ticketDir, version).resultsPath, ManualQaResultsSchema)
}

export function persistManualQaSummary(ticketDir: string, summary: ManualQaSummary): void {
  const parsed = ManualQaSummarySchema.parse(summary)
  writeYaml(getManualQaStoragePaths(ticketDir, parsed.version).summaryPath, parsed)
}

export function readManualQaSummary(ticketDir: string, version: number): ManualQaSummary | null {
  return readYaml(getManualQaStoragePaths(ticketDir, version).summaryPath, ManualQaSummarySchema)
}

export function persistManualQaModelCapabilitySnapshot(
  ticketDir: string,
  snapshot: ManualQaModelCapabilitySnapshot,
): void {
  const parsed = ManualQaModelCapabilitySnapshotSchema.parse(snapshot)
  const path = getManualQaStoragePaths(ticketDir, parsed.version).modelCapabilityPath
  if (existsSync(path)) {
    const existing = ManualQaModelCapabilitySnapshotSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
    if (JSON.stringify(existing) !== JSON.stringify(parsed)) {
      throw new Error('Manual QA model capability snapshot is immutable once captured.')
    }
    return
  }
  safeAtomicWrite(path, JSON.stringify(parsed, null, 2))
}

export function readManualQaModelCapabilitySnapshot(
  ticketDir: string,
  version: number,
): ManualQaModelCapabilitySnapshot | null {
  const path = getManualQaStoragePaths(ticketDir, version).modelCapabilityPath
  if (!existsSync(path)) return null
  return ManualQaModelCapabilitySnapshotSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
}

export function appendManualQaEvent(ticketDir: string, event: ManualQaEvent): ManualQaEvent {
  const parsed = ManualQaEventSchema.parse(event)
  const path = getManualQaStoragePaths(ticketDir, parsed.version).eventsPath
  mkdirSync(resolve(path, '..'), { recursive: true })
  const existing = readJsonl<unknown>(path).map((value) => ManualQaEventSchema.parse(value))
  const duplicate = existing.find((entry) => entry.eventId === parsed.eventId)
  if (duplicate) {
    if (JSON.stringify(duplicate) !== JSON.stringify(parsed)) {
      throw new Error(`Manual QA event ID ${parsed.eventId} was reused with different content.`)
    }
    return duplicate
  }
  appendJsonl(path, parsed)
  return parsed
}

export function readManualQaEvents(ticketDir: string): ManualQaEvent[] {
  const path = resolve(ticketDir, 'manual-qa', 'events.jsonl')
  return readJsonl<unknown>(path).map((value) => ManualQaEventSchema.parse(value))
}

export function snapshotManualQaDraft(ticketDir: string, draft: ManualQaDraft): ManualQaDraft {
  const parsed = ManualQaDraftSchema.parse(draft)
  const snapshotPath = resolve(getManualQaStoragePaths(ticketDir, parsed.version).versionDir, 'manual-qa-draft.yaml')
  if (!existsSync(snapshotPath)) writeYaml(snapshotPath, parsed)
  return parsed
}

export function reserveManualQaVersion(
  ticketDir: string,
  ticketId: string,
  version: number,
  actionId: string = randomUUID(),
): ManualQaGenerationReservation {
  const paths = getManualQaStoragePaths(ticketDir, version)
  mkdirSync(paths.versionDir, { recursive: true })
  if (existsSync(paths.reservationPath)) {
    const existing = JSON.parse(readFileSync(paths.reservationPath, 'utf8')) as ManualQaGenerationReservation
    if (existing.ticketId !== ticketId || existing.version !== version) {
      throw new Error('Manual QA generation reservation does not match the requested ticket/version.')
    }
    return existing
  }
  const reservation: ManualQaGenerationReservation = {
    schemaVersion: MANUAL_QA_SCHEMA_VERSION,
    ticketId,
    version,
    actionId,
    state: 'reserved',
    createdAt: new Date().toISOString(),
  }
  safeAtomicWrite(paths.reservationPath, JSON.stringify(reservation, null, 2))
  return reservation
}

export function completeManualQaReservation(ticketDir: string, reservation: ManualQaGenerationReservation, checklistHash: string): void {
  safeAtomicWrite(
    getManualQaStoragePaths(ticketDir, reservation.version).reservationPath,
    JSON.stringify({
      ...reservation,
      state: 'complete',
      completedAt: new Date().toISOString(),
      checklistHash,
    } satisfies ManualQaGenerationReservation, null, 2),
  )
}

export function listManualQaVersions(ticketDir: string): number[] {
  const root = resolve(ticketDir, 'manual-qa')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^v[1-9]\d*$/.test(entry.name))
    .map((entry) => Number(entry.name.slice(1)))
    .sort((left, right) => left - right)
}

export function allocateNextManualQaVersion(ticketDir: string): number {
  return (listManualQaVersions(ticketDir).at(-1) ?? 0) + 1
}

export function readManualQaEvidenceIndex(ticketDir: string, version: number): ManualQaEvidenceRef[] {
  const paths = getManualQaStoragePaths(ticketDir, version)
  const path = paths.evidenceIndexPath
  if (!existsSync(path)) return []
  resolveContainedEvidencePath(paths.root, paths.evidenceDir, 'index.json')
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  return ManualQaEvidenceRefSchema.array().parse(value)
}

export interface ManualQaEvidenceActionReceipt {
  schemaVersion: 1
  actionId: string
  operation: 'upload' | 'remove'
  state: 'staged' | 'complete'
  evidence: ManualQaEvidenceRef
  createdAt: string
}

function evidenceActionReceiptPath(ticketDir: string, version: number, actionId: string): string {
  const actionHash = createHash('sha256').update(actionId, 'utf8').digest('hex')
  return resolve(getManualQaStoragePaths(ticketDir, version).evidenceDir, 'operations', `${actionHash}.json`)
}

export function readManualQaEvidenceActionReceipt(
  ticketDir: string,
  version: number,
  actionId: string,
): ManualQaEvidenceActionReceipt | null {
  const paths = getManualQaStoragePaths(ticketDir, version)
  const path = evidenceActionReceiptPath(ticketDir, version, actionId)
  if (!existsSync(path)) return null
  const relativeReceipt = relative(paths.evidenceDir, path)
  resolveContainedEvidencePath(paths.root, paths.evidenceDir, relativeReceipt)
  const receipt = JSON.parse(readFileSync(path, 'utf8')) as ManualQaEvidenceActionReceipt
  if (receipt.actionId !== actionId) throw new Error('Evidence action receipt identity does not match its request.')
  return receipt
}

export function persistManualQaEvidenceActionReceipt(
  ticketDir: string,
  version: number,
  actionId: string,
  operation: ManualQaEvidenceActionReceipt['operation'],
  evidence: ManualQaEvidenceRef,
  state: ManualQaEvidenceActionReceipt['state'] = 'complete',
): ManualQaEvidenceActionReceipt {
  const existing = readManualQaEvidenceActionReceipt(ticketDir, version, actionId)
  if (existing) {
    if (
      existing.operation !== operation
      || existing.evidence.id !== evidence.id
      || existing.evidence.itemId !== evidence.itemId
      || existing.evidence.sha256 !== evidence.sha256
    ) throw new Error('Evidence action ID was already used for another operation or evidence item.')
    if (existing.state === 'staged' && state === 'complete') {
      const completed = { ...existing, state: 'complete' as const }
      const paths = getManualQaStoragePaths(ticketDir, version)
      const path = evidenceActionReceiptPath(ticketDir, version, actionId)
      resolveContainedEvidencePath(paths.root, paths.evidenceDir, relative(paths.evidenceDir, path))
      safeAtomicWrite(path, JSON.stringify(completed, null, 2))
      return completed
    }
    return existing
  }
  const receipt: ManualQaEvidenceActionReceipt = {
    schemaVersion: MANUAL_QA_SCHEMA_VERSION,
    actionId,
    operation,
    state,
    evidence: ManualQaEvidenceRefSchema.parse(evidence),
    createdAt: new Date().toISOString(),
  }
  const paths = getManualQaStoragePaths(ticketDir, version)
  const path = evidenceActionReceiptPath(ticketDir, version, actionId)
  resolveContainedEvidencePath(paths.root, paths.evidenceDir, relative(paths.evidenceDir, path), {
    allowMissing: true,
    allowMissingParents: true,
  })
  safeAtomicWrite(path, JSON.stringify(receipt, null, 2))
  return receipt
}

/**
 * Serialises a read-modify-write of the evidence index.
 *
 * Upload and removal each read the index, do filesystem work, and then write a
 * full replacement list. Run concurrently they lost each other's entries — a
 * removal could commit a list built before an upload finished, erasing it.
 *
 * The lock covers both processes and both operations. The fingerprint check is
 * the second half: a lock reclaimed as stale while its holder was merely slow
 * would let two writers into the section, and comparing what the index held
 * when the section started against what it holds at commit time catches that
 * rather than overwriting blind.
 *
 * The Manual QA *version* is the generation token the plan asks for: a restarted
 * run allocates a new version and therefore a different index, so a late
 * completion from an earlier run cannot reach a newly started one.
 */
function evidenceIndexFingerprint(indexPath: string): string {
  try {
    return contentSha256(readFileSync(indexPath, 'utf8'))
  } catch {
    return 'absent'
  }
}

async function withEvidenceIndexLock<T>(
  ticketDir: string,
  version: number,
  run: (current: ManualQaEvidenceRef[]) => { entries: ManualQaEvidenceRef[]; value: T },
): Promise<T> {
  const paths = getManualQaStoragePaths(ticketDir, version)
  return withFileLock(`${paths.evidenceIndexPath}.lock`, () => {
    const before = evidenceIndexFingerprint(paths.evidenceIndexPath)
    // Re-read inside the lock: whatever the caller saw before waiting for it
    // may be several commits old by now.
    const current = readManualQaEvidenceIndex(ticketDir, version)
    const outcome = run(current)
    if (evidenceIndexFingerprint(paths.evidenceIndexPath) !== before) {
      throw new Error('Manual QA evidence index changed while it was being updated; retry the operation.')
    }
    writeEvidenceIndex(ticketDir, version, outcome.entries)
    return outcome.value
  })
}

function writeEvidenceIndex(ticketDir: string, version: number, entries: ManualQaEvidenceRef[]): void {
  const paths = getManualQaStoragePaths(ticketDir, version)
  resolveContainedEvidencePath(paths.root, paths.evidenceDir, 'index.json', { allowMissing: true })
  safeAtomicWrite(
    paths.evidenceIndexPath,
    JSON.stringify(ManualQaEvidenceRefSchema.array().parse(entries), null, 2),
  )
}

function resolveContainedEvidencePath(
  manualQaRoot: string,
  evidenceDir: string,
  storedName: string,
  options: { allowMissing?: boolean; allowMissingParents?: boolean } = {},
): string {
  const rootStats = lstatSync(manualQaRoot)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('Manual QA evidence root is unsafe.')
  }
  const path = resolve(evidenceDir, storedName)
  const lexicalRelative = relative(evidenceDir, path)
  if (
    !lexicalRelative
    || lexicalRelative === '..'
    || lexicalRelative.startsWith(`..${sep}`)
    || lexicalRelative.startsWith('/')
    || lexicalRelative.startsWith('\\')
  ) throw new Error('Evidence path escaped Manual QA storage containment.')

  const parent = dirname(path)
  const parentRelative = relative(manualQaRoot, parent)
  if (
    parentRelative === '..'
    || parentRelative.startsWith(`..${sep}`)
    || parentRelative.startsWith('/')
    || parentRelative.startsWith('\\')
  ) throw new Error('Evidence path escaped Manual QA storage containment.')
  let current = manualQaRoot
  let parentMissing = false
  for (const segment of parentRelative.split(sep).filter(Boolean)) {
    current = resolve(current, segment)
    if (!existsSync(current)) {
      parentMissing = true
      break
    }
    const stats = lstatSync(current)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Evidence path contains an unsafe directory.')
    }
  }
  const realRoot = realpathSync(manualQaRoot)
  if (parentMissing) {
    if (options.allowMissingParents) return path
    throw new Error('Evidence directory is missing.')
  } else {
    const realParent = realpathSync(parent)
    if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) {
      throw new Error('Evidence path escaped Manual QA storage containment.')
    }
  }

  if (!existsSync(path)) {
    if (options.allowMissing) return path
    throw new Error('Evidence path is missing.')
  }
  const stats = lstatSync(path)
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Evidence file is unsafe.')
  const realPath = realpathSync(path)
  if (!realPath.startsWith(`${realRoot}${sep}`)) {
    throw new Error('Evidence path escaped Manual QA storage containment.')
  }
  return path
}

export function sanitizeEvidenceName(input: string): string {
  const withoutControls = basename(input.replace(/\\/g, '/'))
    .normalize('NFKC')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code > 31 && code !== 127
    })
    .join('')
  const normalized = withoutControls
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return (normalized || 'evidence').slice(0, 180)
}

export function isSafeRasterMediaType(mediaType: string): boolean {
  return SAFE_RASTER_TYPES.has(mediaType.toLowerCase())
}

function hasRasterSignature(mediaType: string, header: Uint8Array): boolean {
  const ascii = (start: number, end: number) => String.fromCharCode(...header.slice(start, end))
  switch (mediaType.toLowerCase()) {
    case 'image/png':
      return header.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => header[index] === value)
    case 'image/jpeg':
      return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
    case 'image/gif':
      return header.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')
    case 'image/webp':
      return header.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
    case 'image/avif': {
      if (header.length < 12 || ascii(4, 8) !== 'ftyp') return false
      const brand = ascii(8, 12)
      return brand === 'avif' || brand === 'avis'
    }
    default:
      return false
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function assertContainedDirectory(directory: string, root: string): void {
  const resolvedRootPath = resolve(root)
  const resolvedDirectoryPath = resolve(directory)
  const lexicalRelative = relative(resolvedRootPath, resolvedDirectoryPath)
  if (
    lexicalRelative === '..'
    || lexicalRelative.startsWith(`..${sep}`)
    || lexicalRelative.startsWith('/')
    || lexicalRelative.startsWith('\\')
  ) throw new Error('Evidence directory escaped Manual QA storage containment.')
  const rootStats = lstatSync(resolvedRootPath)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('Evidence path contains an unsafe directory.')
  }
  const realRoot = realpathSync(resolvedRootPath)
  let current = resolvedRootPath
  for (const segment of lexicalRelative.split(sep).filter(Boolean)) {
    const next = resolve(current, segment)
    if (!existsSync(next)) {
      try {
        mkdirSync(next, { mode: 0o700 })
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
      }
    }
    const stats = lstatSync(next)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Evidence path contains an unsafe directory.')
    }
    const realCurrent = realpathSync(next)
    if (realCurrent !== realRoot && !realCurrent.startsWith(`${realRoot}${sep}`)) {
      throw new Error('Evidence directory escaped Manual QA storage containment.')
    }
    current = next
  }
}

export async function streamManualQaEvidence(input: {
  ticketDir: string
  version: number
  itemId: string
  evidenceId: string
  originalName: string
  mediaType: string
  body: ReadableStream<Uint8Array> | null
}): Promise<ManualQaEvidenceRef> {
  if (!input.body) throw new Error('Evidence upload body is required.')
  const evidenceId = input.evidenceId.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(evidenceId)) throw new Error('Invalid evidence ID.')
  const itemId = input.itemId.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(itemId)) throw new Error('Invalid checklist item ID.')

  const paths = getManualQaStoragePaths(input.ticketDir, input.version)
  const checklist = readManualQaChecklist(input.ticketDir, input.version)
  if (!checklist) throw new Error('Manual QA checklist was not found for evidence upload.')
  if (!checklist.items.some((item) => item.id === itemId)) {
    throw new Error(`Evidence references unknown checklist item: ${itemId}`)
  }
  assertContainedDirectory(paths.evidenceDir, paths.root)
  const existing = readManualQaEvidenceIndex(input.ticketDir, input.version)
  if (existing.some((entry) => entry.id === evidenceId)) throw new Error(`Evidence ID already exists: ${evidenceId}`)

  const originalName = sanitizeEvidenceName(input.originalName)
  const extension = extname(originalName).slice(0, 24)
  const itemDirectoryName = `item-${itemId.replace(/[^A-Za-z0-9._-]/g, '_')}`
  const itemDirectory = resolve(paths.evidenceDir, itemDirectoryName)
  assertContainedDirectory(itemDirectory, paths.evidenceDir)
  // Escaped like itemId above: IDs allow ':', which Windows rejects in a
  // filename as the NTFS stream separator.
  const fileStem = evidenceId.replace(/[^A-Za-z0-9._-]/g, '_')
  const fileName = `${fileStem}${extension}`
  const storedName = `${itemDirectoryName}/${fileName}`
  const finalPath = resolve(itemDirectory, fileName)
  const temporaryPath = resolve(itemDirectory, `.${fileStem}.${randomUUID()}.upload`)
  if (!finalPath.startsWith(`${itemDirectory}${sep}`) || !temporaryPath.startsWith(`${itemDirectory}${sep}`)) {
    throw new Error('Evidence path escaped Manual QA storage containment.')
  }

  const handle = await open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600)
  const reader = input.body.getReader()
  const hash = createHash('sha256')
  const signatureBytes: number[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > MAX_MANUAL_QA_EVIDENCE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`Evidence file exceeds ${MAX_MANUAL_QA_EVIDENCE_BYTES} bytes.`)
      }
      hash.update(value)
      for (const byte of value) {
        if (signatureBytes.length >= 16) break
        signatureBytes.push(byte)
      }
      await handle.write(value)
    }
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    rmSync(temporaryPath, { force: true })
    throw error
  } finally {
    reader.releaseLock()
  }
  await handle.close()
  const sha256 = hash.digest('hex')
  if (lstatSync(temporaryPath).isSymbolicLink()) {
    rmSync(temporaryPath, { force: true })
    throw new Error('Evidence upload temporary file is unsafe.')
  }
  if (existsSync(finalPath)) {
    const finalStats = lstatSync(finalPath)
    const matchesInterruptedUpload = finalStats.isFile()
      && !finalStats.isSymbolicLink()
      && finalStats.size === size
      && await sha256File(finalPath) === sha256
    rmSync(temporaryPath, { force: true })
    if (!matchesInterruptedUpload) throw new Error('Evidence destination already exists or is unsafe.')
  } else {
    renameSync(temporaryPath, finalPath)
  }

  const mediaType = (input.mediaType || 'application/octet-stream').trim().toLowerCase()
  const inlinePreview = isSafeRasterMediaType(mediaType)
    && hasRasterSignature(mediaType, Uint8Array.from(signatureBytes))
  const metadata = ManualQaEvidenceRefSchema.parse({
    id: evidenceId,
    itemId,
    originalName,
    storedName,
    mediaType,
    size,
    sha256,
    inlinePreview,
    createdAt: new Date().toISOString(),
  })
  // The index is re-read under the lock because other uploads and removals may
  // have committed while this request streamed its body.
  return withEvidenceIndexLock(input.ticketDir, input.version, (current) => {
    const concurrent = current.find((entry) => entry.id === evidenceId)
    if (concurrent) {
      if (
        concurrent.itemId !== metadata.itemId
        || concurrent.storedName !== metadata.storedName
        || concurrent.mediaType !== metadata.mediaType
        || concurrent.size !== metadata.size
        || concurrent.sha256 !== metadata.sha256
      ) throw new Error(`Evidence ID already exists: ${evidenceId}`)
      // Already committed by an identical retry: leave the list untouched.
      return { entries: current, value: concurrent }
    }
    return { entries: [...current, metadata], value: metadata }
  })
}

export function resolveManualQaEvidence(input: {
  ticketDir: string
  version: number
  itemId: string
  evidenceId: string
}): { metadata: ManualQaEvidenceRef; path: string } {
  const metadata = readManualQaEvidenceIndex(input.ticketDir, input.version)
    .find((entry) => entry.id === input.evidenceId && entry.itemId === input.itemId)
  if (!metadata) throw new Error('Evidence was not found.')
  const paths = getManualQaStoragePaths(input.ticketDir, input.version)
  const path = resolveContainedEvidencePath(paths.root, paths.evidenceDir, metadata.storedName)
  return { metadata, path }
}

export function getManualQaEvidenceRelativePath(version: number, evidence: Pick<ManualQaEvidenceRef, 'storedName'>): string {
  assertVersion(version)
  return `manual-qa/v${version}/evidence/${evidence.storedName}`
}

export function removeManualQaEvidence(input: {
  ticketDir: string
  version: number
  itemId: string
  evidenceId: string
  evidence?: ManualQaEvidenceRef
}): Promise<ManualQaEvidenceRef> {
  // Removal reads the index, deletes a file and writes a replacement list, so
  // it takes the same lock an upload does; it used to commit a list captured
  // before any concurrent upload had finished.
  return withEvidenceIndexLock(input.ticketDir, input.version, (index) => {
    const indexed = index.find((entry) => entry.id === input.evidenceId && entry.itemId === input.itemId)
    const metadata = indexed ?? (input.evidence ? ManualQaEvidenceRefSchema.parse(input.evidence) : null)
    if (!metadata || metadata.id !== input.evidenceId || metadata.itemId !== input.itemId) {
      throw new Error('Evidence was not found.')
    }
    if (indexed && input.evidence && (
      indexed.sha256 !== input.evidence.sha256
      || indexed.storedName !== input.evidence.storedName
    )) throw new Error('Evidence removal receipt does not match the canonical evidence metadata.')
    const paths = getManualQaStoragePaths(input.ticketDir, input.version)
    const path = resolveContainedEvidencePath(paths.root, paths.evidenceDir, metadata.storedName, {
      allowMissing: true,
      allowMissingParents: true,
    })
    // Removing the file before the list is what makes an interrupted removal
    // idempotent: a retry finds no file, and `allowMissing` keeps that quiet.
    rmSync(path, { force: true })
    return {
      entries: index.filter((entry) => entry.id !== input.evidenceId),
      value: metadata,
    }
  })
}

export interface ManualQaVersionDetail {
  checklist: ManualQaChecklist | null
  checklistHash: string | null
  coverage: ManualQaCoverage | null
  results: ManualQaResults | null
  summary: ManualQaSummary | null
  evidence: ManualQaEvidenceRef[]
  modelCapability: ManualQaModelCapabilitySnapshot | null
}

export function getManualQaVersionDetail(ticketDir: string, version: number): ManualQaVersionDetail {
  return {
    checklist: readManualQaChecklist(ticketDir, version),
    checklistHash: getManualQaChecklistHash(ticketDir, version),
    coverage: readManualQaCoverage(ticketDir, version),
    results: readManualQaResults(ticketDir, version),
    summary: readManualQaSummary(ticketDir, version),
    evidence: readManualQaEvidenceIndex(ticketDir, version),
    modelCapability: readManualQaModelCapabilitySnapshot(ticketDir, version),
  }
}

export function resolveActiveManualQaVersion(ticketDir: string): number | null {
  return listManualQaVersions(ticketDir).findLast((version) => {
    const summary = readManualQaSummary(ticketDir, version)
    return !summary || summary.outcome === 'failed'
  }) ?? null
}

export function buildManualQaProjection(ticketId: string) {
  const ticketDir = resolveManualQaTicketDir(ticketId)
  const versionNumbers = listManualQaVersions(ticketDir)
  const activeVersion = resolveActiveManualQaVersion(ticketDir)
  const summaries = versionNumbers.map((version) => readManualQaSummary(ticketDir, version)).filter((value): value is ManualQaSummary => Boolean(value))
  const completedSummaries = summaries.filter((summary) => summary.outcome !== 'failed')
  const waitingAttempts = listPhaseAttempts(ticketId, 'WAITING_MANUAL_QA')
  const versionByAttempt = new Map<number, number>()
  for (const attempt of waitingAttempts) {
    const artifacts = listPhaseArtifacts(ticketId, {
      phase: 'WAITING_MANUAL_QA',
      phaseAttempt: attempt.attemptNumber,
    })
    for (const artifact of artifacts) {
      try {
        if (typeof artifact.content !== 'string') continue
        const parsed = JSON.parse(artifact.content) as { version?: unknown }
        if (typeof parsed.version === 'number' && Number.isInteger(parsed.version) && parsed.version > 0) {
          versionByAttempt.set(attempt.attemptNumber, parsed.version)
          break
        }
      } catch { /* unrelated non-JSON artifact */ }
    }
  }
  const activeWaitingAttempt = waitingAttempts.find((attempt) => attempt.state === 'active')?.attemptNumber ?? null
  const versions: ManualQaVersionIndexEntry[] = versionNumbers.map((version) => {
    const checklist = readManualQaChecklist(ticketDir, version)
    const summary = readManualQaSummary(ticketDir, version)
    const matchedAttempt = [...versionByAttempt.entries()].find(([, candidate]) => candidate === version)?.[0] ?? null
    const phaseAttempt = matchedAttempt ?? (version === activeVersion && checklist ? activeWaitingAttempt : null)
    const completed = Boolean(summary && summary.outcome !== 'failed')
    return {
      version,
      status: completed ? 'completed' : checklist ? summary?.outcome === 'failed' ? 'failed' : 'waiting' : 'generating',
      artifactAvailable: checklist !== null,
      phaseAttempt,
      outcome: summary?.outcome ?? null,
      completedAt: completed ? summary?.completedAt ?? null : null,
    }
  })
  return {
    activeVersion,
    completedRoundCount: completedSummaries.length,
    latestOutcome: summaries.at(-1)?.outcome ?? null,
    artifactAvailable: activeVersion !== null && readManualQaChecklist(ticketDir, activeVersion) !== null,
    versions,
    ...(activeVersion !== null ? { current: getManualQaVersionDetail(ticketDir, activeVersion) } : {}),
  }
}
