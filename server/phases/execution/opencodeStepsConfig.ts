import { createHash } from 'crypto'
import { lstatSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'fs'
import { basename, dirname, join, relative, resolve } from 'path'
import { parseAtomicTmpPath, safeAtomicWriteWithin } from '../../io/atomicWrite'
import { readFileNoFollowSync } from '../../io/readFile'
import { ensureSecureDir, resolveAppConfigDir } from '../../lib/appConfigDir'
import { resolveContainedPath } from '../../lib/containedPath'
import { getErrorMessage, isRecord } from '@shared/typeGuards'

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
const RESTORE_MARKER_DIRECTORY = 'opencode-steps'
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

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function sidecarPathFor(ticketDir: string): string {
  return join(ticketDir, RESTORE_SIDECAR_FILENAME)
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/** The durable recovery record is app state, not mutable worktree content. */
export function getOpencodeStepsRestoreMarkerPath(ticketDir: string): string {
  const name = `${createHash('sha256').update(canonicalPath(ticketDir)).digest('hex')}.json`
  return resolve(resolveAppConfigDir(), RESTORE_MARKER_DIRECTORY, name)
}

function markerLocation(ticketDir: string): { configDir: string; markerPath: string; relativePath: string } {
  const configDir = resolveAppConfigDir()
  const markerPath = getOpencodeStepsRestoreMarkerPath(ticketDir)
  return { configDir, markerPath, relativePath: relative(configDir, markerPath) }
}

/** A repository-relative path for this feature's root configuration file. */
export function isRootOpencodeConfigPath(repoRelativePath: string, worktreePath?: string): boolean {
  const normalized = process.platform === 'win32' ? repoRelativePath.replace(/\\/g, '/') : repoRelativePath
  const path = normalized.replace(/^\.\//, '')
  if (path.includes('/')) return false
  if (path === OPENCODE_CONFIG_FILENAME) return true
  if (!worktreePath) return false
  try {
    const expectedPath = resolve(worktreePath, OPENCODE_CONFIG_FILENAME)
    const candidatePath = resolve(worktreePath, path)
    const expectedStats = lstatSync(expectedPath)
    const candidateStats = lstatSync(candidatePath)
    if (!expectedStats.isFile() || expectedStats.isSymbolicLink()
      || !candidateStats.isFile() || candidateStats.isSymbolicLink()) return false
    return realpathSync.native(expectedPath) === realpathSync.native(candidatePath)
  } catch {
    return false
  }
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
  const staleAfterMs = 60_000
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
      const stats = lstatSync(candidate)
      if (!stats.isFile()) {
        console.warn(`[opencode-steps] Left ${candidate} in place because it is not a regular file`)
        continue
      }
      const match = /\.(\d+)\.[0-9a-f]{12}\.tmp$/i.exec(entry)
      const ownerPid = match ? Number(match[1]) : Number.NaN
      const ageMs = Date.now() - stats.mtimeMs
      let writerStatus: 'alive' | 'dead' | 'unknown' = 'unknown'
      if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && ownerPid <= 0x7fffffff) {
        try {
          process.kill(ownerPid, 0)
          writerStatus = 'alive'
        } catch (error) {
          writerStatus = (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'
        }
      }
      if (ownerPid === process.pid || writerStatus !== 'dead' || ageMs < staleAfterMs) {
        console.warn(`[opencode-steps] Left ${candidate} in place because its writer may still be active`)
        continue
      }
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
    raw = readFileNoFollowSync(configPath)
  } catch (error) {
    return { kind: 'unusable', reason: `it could not be read (${getErrorMessage(error)})` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'unusable', reason: 'it is not readable JSON' }
  }
  if (!isRecord(parsed)) return { kind: 'unusable', reason: 'its top level is not a JSON object' }
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
  if (agent !== undefined && !isRecord(agent)) return null
  const build = isRecord(agent) ? agent.build : undefined
  if (build !== undefined && !isRecord(build)) return null
  return {
    ...existing,
    agent: {
      ...(isRecord(agent) ? agent : {}),
      build: {
        ...(isRecord(build) ? build : {}),
        steps,
      },
    },
  }
}

function serializeConfig(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function safeWriteConfig(configPath: string, content: string): void {
  safeAtomicWriteWithin(dirname(configPath), basename(configPath), content)
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
  const leftoverStatus = readSidecarStatus(params.ticketDir, configPath)
  if (leftoverStatus.kind === 'invalid' || leftoverStatus.kind === 'foreign') {
    const reason = `Left ${OPENCODE_CONFIG_FILENAME} untouched because the authoritative restore marker at ${getOpencodeStepsRestoreMarkerPath(params.ticketDir)} ${leftoverStatus.reason}. The OpenCode step limit is not applied for this run.`
    report(reason)
    return { applied: false, reason }
  }
  const leftover = leftoverStatus.kind === 'valid' ? leftoverStatus.sidecar : null
  if (leftover) {
    removeInterruptedConfigTemps(leftover.configPath)
    const settled = restoreFromSidecar(params.ticketDir, leftover, report)
    if (settled === 'conflict' && readSidecarStatus(params.ticketDir, configPath).kind === 'valid') {
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
    const marker = markerLocation(params.ticketDir)
    ensureSecureDir(marker.configDir)
    ensureSecureDir(dirname(marker.markerPath))
    // The app-owned marker is the recovery authority. The ticket copy remains
    // useful while a run is live, but a worktree reset or model command must
    // not be able to erase the only evidence needed after a crash.
    safeAtomicWriteWithin(
      marker.configDir,
      marker.relativePath,
      `${JSON.stringify(sidecar, null, 2)}\n`,
      { mode: RESTORE_SIDECAR_FILE_MODE },
    )
    // Owner-only: this is a verbatim copy of a file that can hold provider
    // credentials, and it outlives the run whenever a restore cannot complete.
    safeAtomicWriteWithin(
      params.ticketDir,
      RESTORE_SIDECAR_FILENAME,
      `${JSON.stringify(sidecar, null, 2)}\n`,
      { mode: RESTORE_SIDECAR_FILE_MODE },
    )
    safeWriteConfig(configPath, content)
  } catch (error) {
    const reason = `Could not apply the OpenCode step limit: ${getErrorMessage(error)}. ${OPENCODE_CONFIG_FILENAME} is unchanged.`
    report(reason)
    // Keep authoritative evidence after a partially completed write. Recovery
    // can settle an exact original; deleting it here would turn an uncertain
    // write into an unreviewable state.
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
 * record still describes what is on disk and does not need rewriting. An
 * active handle is proof that the retry must remain capped: if its authoritative
 * marker or expected file cannot be verified, abort the retry rather than run
 * the model without the configured limit.
 */
export function reapplyOpencodeStepsConfig(handle: OpencodeStepsConfigHandle, report?: Report): void {
  const notify = notifier(report)
  const markerPath = getOpencodeStepsRestoreMarkerPath(handle.ticketDir)
  const fail = (reason: string): never => {
    const message = `Could not put the OpenCode step limit back after the worktree reset because ${reason} `
      + `The active retry was stopped; resolve the authoritative restore marker at ${markerPath} before retrying.`
    notify(message)
    throw new Error(message)
  }

  const sidecarStatus = readSidecarStatus(handle.ticketDir, handle.configPath)
  if (sidecarStatus.kind === 'foreign') return fail(`the authoritative restore marker at ${markerPath} ${sidecarStatus.reason}.`)
  if (sidecarStatus.kind === 'invalid') return fail(`the authoritative restore marker at ${markerPath} ${sidecarStatus.reason}.`)
  if (sidecarStatus.kind === 'absent') return fail(`the authoritative restore marker at ${markerPath} is missing.`)

  const current = readCurrentConfig(handle.configPath)
  if (current.kind === 'file' && current.raw === handle.appliedContent) return
  if (current.kind === 'foreign') return fail(`the configuration ${current.reason}.`)
  // The reset puts the bytes from before the run back, and `preservePaths` keeps
  // the file from being cleaned away — so the one state worth writing over is
  // exactly those bytes. A file that is gone, or that holds anything else, is
  // somebody's change. Writing over it would do more than lose it: the file
  // would match the restore record again, so the cleanup would read the change
  // as this run's own work and undo it — putting a deleted configuration back,
  // reverting an edit, or deleting a file the run created outright.
  const sidecar = sidecarStatus.sidecar
  if (current.kind !== 'file' || current.raw !== sidecar.originalContent) {
    return fail(`${OPENCODE_CONFIG_FILENAME} was ${current.kind === 'absent' ? 'removed' : 'edited'} after this run wrote it.`)
  }
  try {
    safeWriteConfig(handle.configPath, handle.appliedContent)
  } catch (error) {
    return fail(`putting it back failed: ${getErrorMessage(error)}.`)
  }
}

function removeSidecar(ticketDir: string, expectedConfigPath?: string): void {
  const localPath = sidecarPathFor(ticketDir)
  try {
    const localRaw = readFileNoFollowSync(resolveContainedPath(ticketDir, RESTORE_SIDECAR_FILENAME))
    const parsed: unknown = JSON.parse(localRaw)
    const localStatus = parseSidecarRecord(parsed, expectedConfigPath, localPath)
    // A foreign or malformed worktree record is evidence we cannot attribute;
    // leave it visible even when the app-owned marker has settled successfully.
    if (localStatus.kind === 'valid') unlinkSync(localPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[opencode-steps] Could not remove ${localPath}:`, error)
    }
  }

  const marker = markerLocation(ticketDir)
  try {
    const raw = readFileNoFollowSync(resolveContainedPath(marker.configDir, marker.relativePath))
    const parsed: unknown = JSON.parse(raw)
    const sidecarStatus = parseSidecarRecord(parsed, expectedConfigPath, marker.markerPath)
    if (sidecarStatus.kind === 'valid') unlinkSync(marker.markerPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[opencode-steps] Could not remove ${marker.markerPath}:`, error)
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
 * path straight through. Checking it where the status is read is what makes that
 * mistake unavailable. It also catches the honest version: a project folder that
 * moved since the run. The status reader distinguishes a malformed record owned
 * by this feature from a foreign record, so corruption cannot silently remove
 * the reset/staging safeguards.
 *
 * A valid record comes back carrying the expected path rather than the recorded
 * string, so two spellings of one file cannot send a later write elsewhere.
 */
type SidecarRead =
  | { kind: 'absent' }
  | { kind: 'foreign'; reason: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'valid'; sidecar: RestoreSidecar }

function parseSidecarRecord(parsed: unknown, expectedConfigPath: string | undefined, sidecarPath: string): SidecarRead {
  if (!isRecord(parsed)
    || parsed.schemaVersion !== RESTORE_SIDECAR_SCHEMA_VERSION
    || parsed.owner !== RESTORE_SIDECAR_OWNER) {
    console.warn(`[opencode-steps] Ignoring ${sidecarPath}: it is not a restore record this version wrote`)
    return { kind: 'foreign', reason: 'it belongs to another owner or schema' }
  }
  if (typeof parsed.configPath !== 'string'
    || typeof parsed.createdAt !== 'string'
    || typeof parsed.pid !== 'number'
    || !Number.isSafeInteger(parsed.pid)
    || parsed.pid <= 0
    || typeof parsed.writtenSha256 !== 'string'
    || !/^[0-9a-f]{64}$/i.test(parsed.writtenSha256)
    // The pairing is checked, not just the field types. `'file'` with no
    // bytes would restore an empty document over a real configuration, and
    // `'absent'` with bytes would delete a file somebody's content belongs to.
    || !((parsed.originalType === 'file' && typeof parsed.originalContent === 'string')
      || (parsed.originalType === 'absent' && parsed.originalContent === null))) {
    console.warn(`[opencode-steps] Refusing ${sidecarPath}: its owned restore record is malformed`)
    return { kind: 'invalid', reason: 'its owned restore record is malformed' }
  }
  const expected = expectedConfigPath === undefined ? undefined : resolve(expectedConfigPath)
  if (expected !== undefined && resolve(parsed.configPath) !== expected) {
    console.warn(
      `[opencode-steps] Ignoring ${sidecarPath}: it names ${parsed.configPath}, `
        + `which is not this ticket's ${expected}`,
    )
    return { kind: 'foreign', reason: 'it names a different configuration path' }
  }
  return {
    kind: 'valid',
    sidecar: { ...parsed, configPath: expected ?? resolve(parsed.configPath) } as unknown as RestoreSidecar,
  }
}

function readAuthoritativeSidecarStatus(ticketDir: string, expectedConfigPath: string): SidecarRead {
  const marker = markerLocation(ticketDir)
  let raw: string
  try {
    raw = readFileNoFollowSync(resolveContainedPath(marker.configDir, marker.relativePath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'foreign', reason: `the authoritative marker could not be read safely (${getErrorMessage(error)})` }
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    return parseSidecarRecord(parsed, expectedConfigPath, marker.markerPath)
  } catch {
    console.warn(`[opencode-steps] Refusing authoritative marker ${marker.markerPath}: it is not valid JSON`)
    return { kind: 'invalid', reason: 'the authoritative marker is not valid JSON' }
  }
}

/**
 * Distinguishes a foreign record from a damaged record owned by this feature.
 * The app-owned marker is the only recovery authority. The ticket copy is a
 * live-run convenience copy and is never trusted after the marker is missing.
 */
function readSidecarStatus(ticketDir: string, expectedConfigPath: string): SidecarRead {
  const authoritative = readAuthoritativeSidecarStatus(ticketDir, expectedConfigPath)
  return authoritative
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
    return { kind: 'file', raw: readFileNoFollowSync(configPath) }
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

  // A conflict keeps its restore record even when this run created the file.
  // The record is the ownership evidence that lets reset, staging and squash
  // leave an edited cap visible instead of treating it as ordinary project
  // content. It is removed only once the file is back to the recorded state
  // (or has been removed).
  const keepsOriginal = sidecar.originalType === 'file'
  const conflict = (message: string): RestoreResult => {
    report(`${message} The restore record remains at ${getOpencodeStepsRestoreMarkerPath(ticketDir)} until the conflict is resolved.`)
    return 'conflict'
  }

  if (current.kind === 'foreign') {
    return conflict(`Left ${OPENCODE_CONFIG_FILENAME} as it is because ${current.reason}, so it is not the file this run wrote.`)
  }

  if (current.kind === 'absent') {
    if (keepsOriginal) {
      return conflict(`${OPENCODE_CONFIG_FILENAME} was removed during this run, so the project's own version was not put back.`)
    }
    removeSidecar(ticketDir, sidecar.configPath)
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
    removeSidecar(ticketDir, sidecar.configPath)
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
      removeSidecar(ticketDir, sidecar.configPath)
      return 'removed'
    }
    safeWriteConfig(sidecar.configPath, sidecar.originalContent ?? '')
    removeSidecar(ticketDir, sidecar.configPath)
    return 'restored'
  } catch (error) {
    report(`Could not put ${OPENCODE_CONFIG_FILENAME} back: ${getErrorMessage(error)}`)
    return 'conflict'
  }
}

export function restoreOpencodeStepsConfig(handle: OpencodeStepsConfigHandle, report?: Report): RestoreResult {
  const sidecarStatus = readSidecarStatus(handle.ticketDir, handle.configPath)
  if (sidecarStatus.kind === 'invalid' || sidecarStatus.kind === 'foreign') {
    notifier(report)(
      `Could not restore ${OPENCODE_CONFIG_FILENAME} because the authoritative restore marker at `
        + `${getOpencodeStepsRestoreMarkerPath(handle.ticketDir)} ${sidecarStatus.reason}; `
        + 'leave the capped file in place and resolve it before retrying.',
    )
    return 'conflict'
  }
  const sidecar = sidecarStatus.kind === 'valid' ? sidecarStatus.sidecar : null
  if (!sidecar) {
    // A record we cannot attribute to this feature is not permission to touch
    // either the named file or the capped file. The branch above reports it as
    // a conflict; only an absent record can make the handle's own bytes
    // actionable here.
    const current = readCurrentConfig(handle.configPath)
    if (current.kind === 'file' && current.raw === handle.appliedContent) {
      notifier(report)(
        `Could not restore ${OPENCODE_CONFIG_FILENAME} because ${RESTORE_SIDECAR_FILENAME} is missing. `
        + `The capped file was left in place for review; inspect ${getOpencodeStepsRestoreMarkerPath(handle.ticketDir)} if a recovery marker was retained.`,
      )
      return 'conflict'
    }
    return 'nothing-to-do'
  }
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
  const sidecarStatus = readSidecarStatus(ticketDir, expectedConfigPath)
  if (sidecarStatus.kind === 'invalid' || sidecarStatus.kind === 'foreign') {
    console.warn(`[recovery] Left the authoritative restore marker at ${getOpencodeStepsRestoreMarkerPath(ticketDir)} in place: ${sidecarStatus.reason}`)
    return 'conflict'
  }
  const sidecar = sidecarStatus.kind === 'valid' ? sidecarStatus.sidecar : null
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

/** A valid marker means the capped root file stays out of delivery staging. */
export function hasPendingOpencodeStepsRestore(ticketDir: string, worktreePath: string): boolean {
  const status = readSidecarStatus(ticketDir, opencodeConfigPathFor(worktreePath))
  return status.kind !== 'absent'
}

/** A reset must not overwrite bytes changed after the cap was applied. */
export function hasConflictingOpencodeStepsRestore(ticketDir: string, worktreePath: string): boolean {
  const status = readSidecarStatus(ticketDir, opencodeConfigPathFor(worktreePath))
  if (status.kind === 'invalid' || status.kind === 'foreign') return true
  if (status.kind !== 'valid') return false
  const sidecar = status.sidecar
  const current = readCurrentConfig(sidecar.configPath)
  if (current.kind === 'absent') {
    if (sidecar.originalType === 'absent') removeSidecar(ticketDir, sidecar.configPath)
    return sidecar.originalType !== 'absent'
  }
  if (current.kind !== 'file') return true
  if (sidecar.originalType === 'file' && current.raw === sidecar.originalContent) {
    removeSidecar(ticketDir, sidecar.configPath)
    return false
  }
  return sha256(current.raw) !== sidecar.writtenSha256
}
