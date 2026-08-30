import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { safeAtomicWrite } from '../../io/atomicWrite'
import { getErrorMessage } from '@shared/typeGuards'

/**
 * Capping OpenCode's steps means putting a configuration file in the worktree,
 * and `opencode.json` at a project root is a file OpenCode reads from *any*
 * project — so for a project that ships one, the naive version of this feature
 * is a coding run that replaces the user's configuration with a two-key
 * document and then deletes it.
 *
 * What this module does instead: merge the step cap into whatever is already
 * there, keep the original bytes, and put them back on every exit path —
 * including the next boot, if the process was killed before it could.
 */
export const OPENCODE_CONFIG_FILENAME = 'opencode.json'

/**
 * The restore record lives in the ticket directory, not beside the file it
 * describes. `recoverTicketRuntimeArtifacts` sweeps ticket directories at boot
 * and nothing sweeps worktree roots — widening that sweep would put startup
 * back in the business of rewriting a user's repository, which is the thing
 * `recoverOrphanTmpFiles` was just fixed to stop doing.
 */
const RESTORE_SIDECAR_FILENAME = 'opencode-steps-restore.json'
const RESTORE_SIDECAR_OWNER = 'looptroop/opencode-steps'
const RESTORE_SIDECAR_SCHEMA_VERSION = 1

/**
 * No expiry, deliberately. What makes a restore safe is that the file on disk
 * is still byte-for-byte the one this feature wrote — age says nothing about
 * that. A laptop closed for a month should still get its `opencode.json` back,
 * and a file someone edited in the meantime is left alone whether that happened
 * an hour ago or in March.
 */
interface RestoreSidecar {
  schemaVersion: typeof RESTORE_SIDECAR_SCHEMA_VERSION
  owner: typeof RESTORE_SIDECAR_OWNER
  configPath: string
  createdAt: string
  pid: number
  /** What was at `configPath` before this run: a file we merged into, or nothing. */
  originalType: 'file' | 'absent'
  /** The exact bytes to restore, or `null` when this run created the file. */
  originalContent: string | null
  /** What this run wrote, so an edit made during the run is never clobbered. */
  writtenSha256: string
}

export interface OpencodeStepsConfigHandle {
  ticketDir: string
  configPath: string
  /** True when there was no `opencode.json` and this run made one. */
  created: boolean
}

export type OpencodeStepsConfigOutcome =
  | { applied: true; handle: OpencodeStepsConfigHandle }
  | { applied: false; reason: string }

type Report = (message: string) => void

const reportToConsole: Report = (message) => { console.warn(`[opencode-steps] ${message}`) }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function sidecarPathFor(ticketDir: string): string {
  return join(ticketDir, RESTORE_SIDECAR_FILENAME)
}

type ExistingConfig =
  | { kind: 'absent' }
  | { kind: 'file'; raw: string; value: Record<string, unknown> }
  | { kind: 'unusable'; reason: string }

/**
 * Reads the project's own `opencode.json`, refusing anything this feature
 * cannot put back exactly as it found it.
 *
 * A symlink is refused rather than followed: writing through it would edit a
 * file outside the worktree, and restoring afterwards would not undo that.
 */
function readExistingConfig(configPath: string): ExistingConfig {
  let stats
  try {
    stats = lstatSync(configPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unusable', reason: `it could not be inspected (${getErrorMessage(error)})` }
  }
  if (stats.isSymbolicLink()) return { kind: 'unusable', reason: 'it is a symbolic link' }
  if (!stats.isFile()) return { kind: 'unusable', reason: 'it is not a regular file' }

  let raw: string
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch (error) {
    return { kind: 'unusable', reason: `it could not be read (${getErrorMessage(error)})` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'unusable', reason: 'it is not readable JSON' }
  }
  if (!isPlainObject(parsed)) return { kind: 'unusable', reason: 'its top level is not a JSON object' }
  return { kind: 'file', raw, value: parsed }
}

/** The document written when the project has no `opencode.json` of its own. */
function minimalConfig(steps: number): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    agent: { build: { steps } },
  }
}

/**
 * The project's configuration with the step cap merged in, or `null` when
 * `agent` or `agent.build` is something other than an object and merging would
 * mean discarding it.
 */
function mergeSteps(existing: Record<string, unknown>, steps: number): Record<string, unknown> | null {
  const agent = existing.agent
  if (agent !== undefined && !isPlainObject(agent)) return null
  const build = isPlainObject(agent) ? agent.build : undefined
  if (build !== undefined && !isPlainObject(build)) return null
  return {
    ...existing,
    agent: {
      ...(isPlainObject(agent) ? agent : {}),
      build: {
        ...(isPlainObject(build) ? build : {}),
        steps,
      },
    },
  }
}

function serializeConfig(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Applies the step cap, preserving whatever configuration the project already had.
 *
 * The restore record is written *before* the configuration, so the worst a
 * crash between the two can leave is a record whose hash matches nothing — and
 * the mismatch path is "leave the file alone", which is correct, because in
 * that case the file was never touched.
 */
export function applyOpencodeStepsConfig(params: {
  ticketDir: string
  worktreePath: string
  steps: number
  report?: Report
}): OpencodeStepsConfigOutcome {
  const report = params.report ?? reportToConsole
  const configPath = resolve(params.worktreePath, OPENCODE_CONFIG_FILENAME)
  const existing = readExistingConfig(configPath)

  if (existing.kind === 'unusable') {
    const reason = `Left ${OPENCODE_CONFIG_FILENAME} untouched because ${existing.reason}. The OpenCode step limit is not applied for this run.`
    report(reason)
    return { applied: false, reason }
  }

  const created = existing.kind === 'absent'
  const document = created ? minimalConfig(params.steps) : mergeSteps(existing.value, params.steps)
  if (document === null) {
    const reason = `Left ${OPENCODE_CONFIG_FILENAME} untouched because its "agent" section is not shaped the way a step limit can be merged into. The OpenCode step limit is not applied for this run.`
    report(reason)
    return { applied: false, reason }
  }

  const content = serializeConfig(document)
  const sidecar: RestoreSidecar = {
    schemaVersion: RESTORE_SIDECAR_SCHEMA_VERSION,
    owner: RESTORE_SIDECAR_OWNER,
    configPath,
    createdAt: new Date().toISOString(),
    pid: process.pid,
    originalType: created ? 'absent' : 'file',
    originalContent: created ? null : existing.raw,
    writtenSha256: sha256(content),
  }

  try {
    safeAtomicWrite(sidecarPathFor(params.ticketDir), `${JSON.stringify(sidecar, null, 2)}\n`)
    safeAtomicWrite(configPath, content)
  } catch (error) {
    const reason = `Could not apply the OpenCode step limit: ${getErrorMessage(error)}. ${OPENCODE_CONFIG_FILENAME} is unchanged.`
    report(reason)
    removeSidecar(params.ticketDir)
    return { applied: false, reason }
  }

  return { applied: true, handle: { ticketDir: params.ticketDir, configPath, created } }
}

function removeSidecar(ticketDir: string): void {
  try {
    unlinkSync(sidecarPathFor(ticketDir))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[opencode-steps] Could not remove ${sidecarPathFor(ticketDir)}:`, error)
    }
  }
}

function readSidecar(ticketDir: string): RestoreSidecar | null {
  let raw: string
  try {
    raw = readFileSync(sidecarPathFor(ticketDir), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      isPlainObject(parsed)
      && parsed.schemaVersion === RESTORE_SIDECAR_SCHEMA_VERSION
      && parsed.owner === RESTORE_SIDECAR_OWNER
      && typeof parsed.configPath === 'string'
      && (parsed.originalType === 'file' || parsed.originalType === 'absent')
      && (typeof parsed.originalContent === 'string' || parsed.originalContent === null)
      && typeof parsed.writtenSha256 === 'string'
    ) {
      return parsed as unknown as RestoreSidecar
    }
  } catch {
    // Falls through to the warning below.
  }
  console.warn(`[opencode-steps] Ignoring ${sidecarPathFor(ticketDir)}: it is not a restore record this version wrote`)
  return null
}

/** What is at `configPath` now, as far as the restore decision is concerned. */
function readCurrentConfig(configPath: string): { kind: 'absent' } | { kind: 'file'; raw: string } | { kind: 'foreign'; reason: string } {
  let stats
  try {
    stats = lstatSync(configPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'foreign', reason: `it could not be inspected (${getErrorMessage(error)})` }
  }
  if (stats.isSymbolicLink()) return { kind: 'foreign', reason: 'it is now a symbolic link' }
  if (!stats.isFile()) return { kind: 'foreign', reason: 'it is no longer a regular file' }
  try {
    return { kind: 'file', raw: readFileSync(configPath, 'utf8') }
  } catch (error) {
    return { kind: 'foreign', reason: `it could not be read (${getErrorMessage(error)})` }
  }
}

type RestoreResult = 'restored' | 'removed' | 'conflict' | 'nothing-to-do'

/**
 * Undoes one application of the step cap.
 *
 * The rule throughout is that this feature only ever takes back its own write.
 * If the file on disk is not the one it wrote — someone edited it during the
 * run, replaced it, or deleted it — the difference is theirs and it is reported
 * rather than overwritten.
 */
function restoreFromSidecar(ticketDir: string, sidecar: RestoreSidecar, report: Report): RestoreResult {
  const current = readCurrentConfig(sidecar.configPath)

  // A conflict keeps its restore record when — and only when — that record
  // holds the project's original bytes. It is then the only copy of them, and
  // deleting it to keep the directory tidy is the one deletion this module
  // exists to prevent. With nothing to preserve, it goes, so the same warning
  // does not reappear at every boot for the rest of the ticket's life.
  const keepsOriginal = sidecar.originalType === 'file'
  const conflict = (message: string): RestoreResult => {
    report(keepsOriginal ? `${message} The version from before the run is still in ${RESTORE_SIDECAR_FILENAME}.` : message)
    if (!keepsOriginal) removeSidecar(ticketDir)
    return 'conflict'
  }

  if (current.kind === 'foreign') {
    return conflict(`Left ${OPENCODE_CONFIG_FILENAME} as it is because ${current.reason}, so it is not the file this run wrote.`)
  }

  if (current.kind === 'absent') {
    if (keepsOriginal) {
      return conflict(`${OPENCODE_CONFIG_FILENAME} was removed during this run, so the project's own version was not put back.`)
    }
    removeSidecar(ticketDir)
    return 'nothing-to-do'
  }

  if (sha256(current.raw) !== sidecar.writtenSha256) {
    return conflict(
      keepsOriginal
        ? `Left ${OPENCODE_CONFIG_FILENAME} as it is because it changed during this run.`
        : `Kept the ${OPENCODE_CONFIG_FILENAME} this run created, because it has been edited since it was written.`,
    )
  }

  try {
    if (sidecar.originalType === 'absent') {
      rmSync(sidecar.configPath, { force: true })
      removeSidecar(ticketDir)
      return 'removed'
    }
    safeAtomicWrite(sidecar.configPath, sidecar.originalContent ?? '')
    removeSidecar(ticketDir)
    return 'restored'
  } catch (error) {
    report(`Could not put ${OPENCODE_CONFIG_FILENAME} back: ${getErrorMessage(error)}`)
    return 'conflict'
  }
}

export function restoreOpencodeStepsConfig(handle: OpencodeStepsConfigHandle, report?: Report): RestoreResult {
  const sidecar = readSidecar(handle.ticketDir)
  if (!sidecar) return 'nothing-to-do'
  return restoreFromSidecar(handle.ticketDir, sidecar, report ?? reportToConsole)
}

/**
 * The boot half: a run killed outright never reached its `finally`, so the
 * restore happens at the next startup instead. Returns true when a project's
 * own `opencode.json` was put back.
 */
export function restoreInterruptedOpencodeStepsConfig(ticketDir: string): boolean {
  const sidecar = readSidecar(ticketDir)
  if (!sidecar) return false
  const result = restoreFromSidecar(ticketDir, sidecar, (message) => { console.warn(`[recovery] ${message}`) })
  if (result === 'restored') {
    console.log(`[recovery] Restored ${sidecar.configPath} after an interrupted coding run`)
  } else if (result === 'removed') {
    console.log(`[recovery] Removed the ${OPENCODE_CONFIG_FILENAME} left behind by an interrupted coding run at ${sidecar.configPath}`)
  }
  return result === 'restored' || result === 'removed'
}
