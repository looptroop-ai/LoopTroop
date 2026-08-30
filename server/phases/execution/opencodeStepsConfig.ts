import { createHash } from 'crypto'
import { lstatSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { parseAtomicTmpPath, safeAtomicWrite } from '../../io/atomicWrite'
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
/** It holds a copy of a file that can carry provider credentials. */
const RESTORE_SIDECAR_FILE_MODE = 0o600

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
  /**
   * Exactly what this run wrote. Kept so the cap can be put back after one of
   * LoopTroop's own worktree resets without re-reading anything: the bytes are
   * identical, so the restore record still matches and needs no rewrite.
   */
  appliedContent: string
}

export type OpencodeStepsConfigOutcome =
  | { applied: true; handle: OpencodeStepsConfigHandle }
  | { applied: false; reason: string }

type Report = (message: string) => void

/**
 * Every message goes to the console *and* to the caller's reporter, which is
 * the ticket log during a run. One or the other is not enough: the console is
 * where an operator looks, and the ticket log is where the person whose step
 * cap did not apply is looking.
 */
function notifier(report?: Report): Report {
  return (message) => {
    console.warn(`[opencode-steps] ${message}`)
    report?.(message)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function sidecarPathFor(ticketDir: string): string {
  return join(ticketDir, RESTORE_SIDECAR_FILENAME)
}

/** The one path this feature is ever allowed to touch for a given worktree. */
export function opencodeConfigPathFor(worktreePath: string): string {
  return resolve(worktreePath, OPENCODE_CONFIG_FILENAME)
}

/**
 * Clears away a temp file left beside the config by an interrupted write.
 *
 * `safeAtomicWrite` puts its temp next to its target, and this target is the
 * worktree root — outside everything startup sweeps. Left alone it shows up in
 * `git status` and can be committed as an ordinary project file. The sidecar
 * names the exact target, so this stays a single-file check rather than a
 * reason to sweep a user's repository.
 */
function removeInterruptedConfigTemps(configPath: string): void {
  let entries: string[]
  try {
    entries = readdirSync(dirname(configPath))
  } catch {
    return
  }
  for (const entry of entries) {
    const candidate = join(dirname(configPath), entry)
    if (parseAtomicTmpPath(candidate) !== configPath) continue
    try {
      unlinkSync(candidate)
      console.warn(`[opencode-steps] Removed ${candidate}, left behind by an interrupted write`)
    } catch (error) {
      console.warn(`[opencode-steps] Could not remove ${candidate}:`, error)
    }
  }
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
  const report = notifier(params.report)
  const configPath = opencodeConfigPathFor(params.worktreePath)

  // A record left over from an earlier run is settled before this one starts.
  // Most of them resolve to nothing — the file is already the project's own —
  // but one that survives holds the only copy of bytes nothing else has, and
  // overwriting it here is how that copy would be lost.
  const leftover = readSidecar(params.ticketDir, configPath)
  if (leftover) {
    removeInterruptedConfigTemps(leftover.configPath)
    const settled = restoreFromSidecar(params.ticketDir, leftover, report)
    if (settled === 'conflict' && readSidecar(params.ticketDir, configPath) !== null) {
      const reason = `Left ${OPENCODE_CONFIG_FILENAME} untouched: an earlier run's copy of this project's own version is still waiting in ${RESTORE_SIDECAR_FILENAME}. The OpenCode step limit is not applied for this run.`
      report(reason)
      return { applied: false, reason }
    }
  }

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
    // Owner-only: this is a verbatim copy of a file that can hold provider
    // credentials, and it outlives the run whenever a restore cannot complete.
    safeAtomicWrite(
      sidecarPathFor(params.ticketDir),
      `${JSON.stringify(sidecar, null, 2)}\n`,
      { mode: RESTORE_SIDECAR_FILE_MODE },
    )
    safeAtomicWrite(configPath, content)
  } catch (error) {
    const reason = `Could not apply the OpenCode step limit: ${getErrorMessage(error)}. ${OPENCODE_CONFIG_FILENAME} is unchanged.`
    report(reason)
    removeSidecar(params.ticketDir)
    return { applied: false, reason }
  }

  return {
    applied: true,
    handle: { ticketDir: params.ticketDir, configPath, created, appliedContent: content },
  }
}

/**
 * Puts the cap back after one of LoopTroop's own worktree resets.
 *
 * A retry runs `git reset --hard`, which returns a tracked `opencode.json` to
 * its committed state — so without this the cap silently stops applying part
 * way through a run. The bytes are the ones already recorded, so the restore
 * record still describes what is on disk and does not need rewriting.
 */
export function reapplyOpencodeStepsConfig(handle: OpencodeStepsConfigHandle, report?: Report): void {
  const notify = notifier(report)
  const current = readCurrentConfig(handle.configPath)
  if (current.kind === 'file' && current.raw === handle.appliedContent) return
  if (current.kind === 'foreign') {
    notify(`Did not put the OpenCode step limit back after the worktree reset because ${current.reason}.`)
    return
  }
  // Only a state the reset itself could have produced is written over: the file
  // gone, or exactly the bytes from before the run. Anything else is somebody's
  // edit, and writing over it would do more than lose it — the restore record
  // would match again, so the cleanup would read the edited file as this run's
  // own work and either revert it or, for a file the run created, delete it.
  const sidecar = readSidecar(handle.ticketDir, handle.configPath)
  if (!sidecar) {
    notify(
      `Did not put the OpenCode step limit back after the worktree reset because ${RESTORE_SIDECAR_FILENAME} `
        + 'is gone, so there would be no way to put the file back afterwards.',
    )
    return
  }
  if (current.kind === 'file' && current.raw !== sidecar.originalContent) {
    notify(
      `Did not put the OpenCode step limit back after the worktree reset because ${OPENCODE_CONFIG_FILENAME} `
        + 'has been edited since this run wrote it.',
    )
    return
  }
  try {
    safeAtomicWrite(handle.configPath, handle.appliedContent)
  } catch (error) {
    notify(`Could not put the OpenCode step limit back after the worktree reset: ${getErrorMessage(error)}.`)
  }
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

/**
 * Reads the restore record, refusing one that does not describe
 * `expectedConfigPath`.
 *
 * The check belongs here rather than at the call sites. A restore record is a
 * file in the worktree, which means anything running inside the worktree —
 * including the model — can write one, and what this function hands back goes on
 * to `rmSync` and `safeAtomicWrite`. All three callers already know the one path
 * this feature is allowed to touch, and two of them used to pass the recorded
 * path straight through. Checking it where the record is read is what makes that
 * mistake unavailable. It also catches the honest version: a project folder that
 * moved since the run.
 *
 * The record comes back carrying the expected path rather than the recorded
 * string, so two spellings of one file cannot send a later write elsewhere.
 */
function readSidecar(ticketDir: string, expectedConfigPath: string): RestoreSidecar | null {
  let raw: string
  try {
    raw = readFileSync(sidecarPathFor(ticketDir), 'utf8')
  } catch {
    return null
  }
  const expected = resolve(expectedConfigPath)
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      isPlainObject(parsed)
      && parsed.schemaVersion === RESTORE_SIDECAR_SCHEMA_VERSION
      && parsed.owner === RESTORE_SIDECAR_OWNER
      && typeof parsed.configPath === 'string'
      && typeof parsed.writtenSha256 === 'string'
      // The pairing is checked, not just the field types. `'file'` with no
      // bytes would restore an empty document over a real configuration, and
      // `'absent'` with bytes would delete a file somebody's content belongs to.
      && ((parsed.originalType === 'file' && typeof parsed.originalContent === 'string')
        || (parsed.originalType === 'absent' && parsed.originalContent === null))
    ) {
      if (resolve(parsed.configPath) !== expected) {
        console.warn(
          `[opencode-steps] Ignoring ${sidecarPathFor(ticketDir)}: it names ${parsed.configPath}, `
            + `which is not this ticket's ${expected}`,
        )
        return null
      }
      return { ...parsed, configPath: expected } as unknown as RestoreSidecar
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

export type RestoreResult = 'restored' | 'removed' | 'conflict' | 'nothing-to-do'

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

  // Already the project's own file, so there is nothing to undo and nothing
  // worth keeping a record of. Three ordinary things land here: a kill between
  // the record being written and the configuration being replaced, a kill after
  // the restore wrote but before the record was removed, and one of LoopTroop's
  // own worktree resets reverting a tracked file. Without this they are all read
  // as "somebody edited it", which is both untrue and permanent — the record
  // would be kept and the warning repeated at every boot for the life of the
  // ticket.
  if (keepsOriginal && current.raw === sidecar.originalContent) {
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
  const sidecar = readSidecar(handle.ticketDir, handle.configPath)
  if (!sidecar) return 'nothing-to-do'
  const result = restoreFromSidecar(handle.ticketDir, sidecar, notifier(report))
  removeInterruptedConfigTemps(handle.configPath)
  return result
}

/**
 * The boot half: a run killed outright never reached its `finally`, so the
 * restore happens at the next startup instead.
 *
 * `worktreePath` is passed in rather than taken from the record, so a record can
 * only ever be acted on for the file it belongs to. `readSidecar` is where that
 * is enforced, and says why.
 */
export function restoreInterruptedOpencodeStepsConfig(
  ticketDir: string,
  worktreePath: string,
): RestoreResult {
  const expectedConfigPath = opencodeConfigPathFor(worktreePath)
  const sidecar = readSidecar(ticketDir, expectedConfigPath)
  if (!sidecar) return 'nothing-to-do'

  removeInterruptedConfigTemps(expectedConfigPath)
  const result = restoreFromSidecar(ticketDir, sidecar, (message) => { console.warn(`[recovery] ${message}`) })
  if (result === 'restored') {
    console.log(`[recovery] Restored ${sidecar.configPath} after an interrupted coding run`)
  } else if (result === 'removed') {
    console.log(`[recovery] Removed the ${OPENCODE_CONFIG_FILENAME} left behind by an interrupted coding run at ${sidecar.configPath}`)
  }
  return result
}
