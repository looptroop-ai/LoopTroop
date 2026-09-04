import { withGitIndexRollback } from '../../git/indexSnapshot'
import { REPO_SCOPE_PATHSPECS } from '../../git/pathspecs'
import { normalizeRepoScopedPath, uniqueRepoScopedPaths } from '../../git/repoScopedPath'
import { runGitSync } from '../../git/runCommand'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  captureFinalTestDirtyFiles,
  resolveFinalTestCandidateFiles,
  restoreTrackedFinalTestLocalFiles,
  type FinalTestDirtyFile,
} from '../finalTest/fileEffectsAudit'
import { getTicketByRef, getTicketPaths } from '../../storage/tickets'
import { appendManualQaEvent } from './storage'
import { safeAtomicWrite } from '../../io/atomicWrite'
import {
  classifyWorktreePath,
  getExecutionSetupCommitExcludedRoots,
} from '../../git/worktreeChanges'

export interface ManualQaWorkspaceBaseline {
  schemaVersion: 1
  version: number
  createdAt: string
  head: string
  status: FinalTestDirtyFile[]
  localOnlyPaths: string[]
  trackedSignatures: Record<string, string>
}

export interface ManualQaCheckpointResult {
  baseline: ManualQaWorkspaceBaseline
  checkpointCommit: string | null
  candidateFiles: string[]
  quarantinedFiles: string[]
}

interface ManualQaDriftReceipt {
  schemaVersion: 1
  actionId: string
  version: number
  decision: 'include' | 'discard'
  files: string[]
  previousHead: string
  resultingHead: string
  createdAt: string
}

/**
 * Baselines and drift receipts record what a worktree looked like, path by
 * path. Owner-only, as they were before this went through the shared writer.
 */
const RECEIPT_FILE_MODE = 0o600

// The fourth copy of this rule, now shared with the two audits and the squash
// filter. It accepts one thing the local copy rejected — a doubled separator,
// which it collapses rather than refuses — and is otherwise identical.
const normalizeProjectPath = normalizeRepoScopedPath
const uniqueProjectPaths = uniqueRepoScopedPaths

function literalPathspec(filePath: string): string {
  return `:(literal)${filePath}`
}

/** Runs git, or throws with the command that failed. Output is untouched. */
function runGitRaw(worktreePath: string, args: string[]): string {
  // The runner's own trim is off because these callers read NUL-delimited
  // records, where a leading byte can legitimately be a space. Nothing here
  // trims either, so a record's first field survives whatever it starts with.
  const result = runGitSync(worktreePath, args, { trimOutput: false })
  if (!result.ok) {
    throw new Error(`git ${args[0] ?? ''} failed: ${result.errorDetail}`)
  }
  return result.stdout
}

/**
 * The same, for output read as a single token or as newline-separated lines.
 *
 * Kept separate from `runGitRaw` rather than switched on the arguments: which
 * of the two a command needs is the caller's knowledge, and a `-z` reader that
 * quietly got the trimming one is the bug this split exists to make impossible.
 */
function runGit(worktreePath: string, args: string[], allowEmpty = false): string {
  const output = runGitRaw(worktreePath, args).trim()
  if (!allowEmpty && !output && args[0] === 'rev-parse') {
    throw new Error(`git ${args.join(' ')} returned no result`)
  }
  return output
}

function assertContained(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('/') || rel.startsWith('\\')) {
    throw new Error(`Manual QA path escapes its contained root: ${target}`)
  }
}

/**
 * Baseline and drift receipts are what a manual QA session is reconstructed
 * from after a crash, so they go through the same writer as every other durable
 * artifact: fsynced, retried past a Windows handle, and left under a temp name
 * startup recovery can identify. The private writer this replaced had none of
 * that.
 */
function writeReceiptJson(path: string, value: unknown): void {
  safeAtomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, { mode: RECEIPT_FILE_MODE })
}

function baselinePath(ticketDir: string, version: number): string {
  return join(ticketDir, 'manual-qa', `workspace-baseline-v${version}.json`)
}

function driftReceiptPath(ticketDir: string, actionId: string): string {
  const actionHash = createHash('sha256').update(actionId, 'utf8').digest('hex')
  return join(ticketDir, 'manual-qa', `workspace-drift-${actionHash}.json`)
}

function readReceipt(path: string): ManualQaDriftReceipt | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ManualQaDriftReceipt
  } catch {
    throw new Error(`Manual QA drift receipt is invalid: ${path}`)
  }
}

function appendDriftEvent(ticketDir: string, ticketExternalId: string, receipt: ManualQaDriftReceipt): void {
  appendManualQaEvent(ticketDir, {
    schemaVersion: 1,
    eventId: `drift-${receipt.decision}-${createHash('sha256').update(receipt.actionId).digest('hex').slice(0, 24)}`,
    eventType: receipt.decision === 'include' ? 'drift_included' : 'drift_discarded',
    ticketId: ticketExternalId,
    version: receipt.version,
    actionId: receipt.actionId,
    createdAt: receipt.createdAt,
    data: {
      files: receipt.files,
      previousHead: receipt.previousHead,
      resultingHead: receipt.resultingHead,
    },
  })
}

function captureTrackedSignatures(worktreePath: string): Record<string, string> {
  const output = runGitRaw(worktreePath, ['ls-files', '-s', '-z'])
  const signatures: Record<string, string> = {}
  for (const entry of output.split('\0')) {
    if (!entry) continue
    const match = entry.match(/^\d+ ([0-9a-f]+) \d+\t(.+)$/)
    if (!match?.[1] || !match[2]) continue
    const path = normalizeProjectPath(match[2])
    if (path) signatures[path] = match[1]
  }
  return signatures
}

function filterDeliveryRelevantDirtyFiles(
  worktreePath: string,
  dirtyFiles: FinalTestDirtyFile[],
  localOnlyPaths: string[] = [],
): FinalTestDirtyFile[] {
  const localOnly = new Set(uniqueProjectPaths(localOnlyPaths))
  const setupExcludedRoots = getExecutionSetupCommitExcludedRoots(worktreePath)
  return dirtyFiles.filter((file) => (
    !localOnly.has(file.path)
    && classifyWorktreePath(file.path, {
      setupExcludedRoots,
      untracked: file.untracked,
    }).category === 'committable'
  ))
}

function captureBaseline(
  worktreePath: string,
  version: number,
  localOnlyPaths: string[] = [],
): ManualQaWorkspaceBaseline {
  const normalizedLocalOnlyPaths = uniqueProjectPaths(localOnlyPaths)
  return {
    schemaVersion: 1,
    version,
    createdAt: new Date().toISOString(),
    head: runGit(worktreePath, ['rev-parse', 'HEAD']),
    status: filterDeliveryRelevantDirtyFiles(
      worktreePath,
      captureFinalTestDirtyFiles(worktreePath),
      normalizedLocalOnlyPaths,
    ),
    localOnlyPaths: normalizedLocalOnlyPaths,
    trackedSignatures: captureTrackedSignatures(worktreePath),
  }
}

function readBaseline(ticketDir: string, version: number): ManualQaWorkspaceBaseline {
  const path = baselinePath(ticketDir, version)
  if (!existsSync(path)) throw new Error(`Manual QA workspace baseline is missing for v${version}`)
  const value = JSON.parse(readFileSync(path, 'utf8')) as ManualQaWorkspaceBaseline
  if (
    value.schemaVersion !== 1
    || value.version !== version
    || !value.head
    || !Array.isArray(value.localOnlyPaths)
  ) {
    throw new Error(`Manual QA workspace baseline is invalid for v${version}`)
  }
  return value
}

function captureCommittedDrift(worktreePath: string, baselineHead: string, currentHead: string): Map<string, string> {
  if (baselineHead === currentHead) return new Map()
  const output = runGitRaw(worktreePath, [
    'diff',
    '--name-status',
    '--no-renames',
    '-z',
    `${baselineHead}..${currentHead}`,
    '--',
    ...REPO_SCOPE_PATHSPECS,
  ])
  const fields = output.split('\0').filter(Boolean)
  const drift = new Map<string, string>()
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index] ?? ''
    const path = normalizeProjectPath(fields[index + 1] ?? '')
    if (path) drift.set(path, status[0] ?? 'M')
  }
  return drift
}

function quarantineFiles(
  worktreePath: string,
  ticketDir: string,
  version: number,
  files: string[],
): string[] {
  const quarantineRoot = join(ticketDir, 'manual-qa', `v${version}`, 'quarantine')
  const quarantined: string[] = []
  for (const file of uniqueProjectPaths(files)) {
    const source = resolve(worktreePath, file)
    const destination = resolve(quarantineRoot, file)
    assertContained(worktreePath, source)
    assertContained(quarantineRoot, destination)
    if (!existsSync(source) && !lstatSafe(source)) continue
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination, { recursive: true, dereference: false, errorOnExist: false, force: true })
    quarantined.push(file)
  }
  return quarantined
}

function lstatSafe(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function discardExactFiles(worktreePath: string, files: string[], dirtyFiles: FinalTestDirtyFile[]): void {
  const dirtyByPath = new Map(dirtyFiles.map(file => [file.path, file]))
  const normalizedFiles = uniqueProjectPaths(files).filter(file => dirtyByPath.has(file))
  const tracked = normalizedFiles.filter(file => !dirtyByPath.get(file)?.untracked)
  const untracked = normalizedFiles.filter(file => dirtyByPath.get(file)?.untracked)
  if (tracked.length > 0) {
    runGit(worktreePath, ['restore', '--staged', '--worktree', '--', ...tracked.map(literalPathspec)], true)
  }
  if (untracked.length > 0) {
    runGit(worktreePath, ['clean', '-fd', '--', ...untracked.map(literalPathspec)], true)
  }
}

function commitExactFiles(worktreePath: string, files: string[], message: string): string | null {
  const normalizedFiles = uniqueProjectPaths(files)
  if (normalizedFiles.length === 0) return null
  const pathspecs = normalizedFiles.map(literalPathspec)
  // Staged and committed under an index snapshot, like the bead commit. `git
  // add` here writes the worktree's own index, and a commit that then threw
  // used to leave these paths staged for whatever committed next.
  const committed = withGitIndexRollback(worktreePath, () => {
    runGit(worktreePath, ['add', '-f', '-A', '--', ...pathspecs], true)
    const staged = runGit(worktreePath, ['diff', '--cached', '--name-only', '--', ...pathspecs], true)
    if (!staged) return { keepIndex: false, value: false }
    // `git commit` normally includes every path already staged in the worktree.
    // Restrict the commit itself so unrelated staged application/runtime residue
    // cannot leak into the clean Manual QA checkpoint before it is quarantined.
    runGit(worktreePath, [
      '-c',
      'user.name=LoopTroop',
      '-c',
      'user.email=looptroop@local',
      'commit',
      '--no-verify',
      '-m',
      message,
      '--only',
      '--',
      ...pathspecs,
    ], true)
    return { keepIndex: true, value: true }
  })
  if (!committed) return null
  return runGit(worktreePath, ['rev-parse', 'HEAD'])
}

export function prepareManualQaCheckpoint(ticketId: string, version: number): ManualQaCheckpointResult {
  const paths = getTicketPaths(ticketId)
  const ticket = getTicketByRef(ticketId)
  if (!paths || !ticket) throw new Error(`Ticket workspace not initialized: ${ticketId}`)
  if (!Number.isInteger(version) || version < 1) throw new Error('Manual QA version must be a positive integer')

  const existingBaselinePath = baselinePath(paths.ticketDir, version)
  if (existsSync(existingBaselinePath)) {
    const baseline = JSON.parse(readFileSync(existingBaselinePath, 'utf8')) as ManualQaWorkspaceBaseline
    const currentStatus = filterDeliveryRelevantDirtyFiles(
      paths.worktreePath,
      captureFinalTestDirtyFiles(paths.worktreePath),
      baseline.localOnlyPaths,
    )
    if (baseline.head === runGit(paths.worktreePath, ['rev-parse', 'HEAD']) && currentStatus.length === 0) {
      return { baseline, checkpointCommit: baseline.head, candidateFiles: [], quarantinedFiles: [] }
    }
  }

  const resolution = resolveFinalTestCandidateFiles(ticketId)
  const audit = resolution.audit
  const candidateFiles = uniqueProjectPaths(resolution.candidateFiles)
  const checkpointCommit = commitExactFiles(
    paths.worktreePath,
    candidateFiles,
    `${ticket.externalId}: checkpoint accepted final-test effects for Manual QA v${version}`,
  )

  const localOnlyPaths = uniqueProjectPaths(audit?.localOnlyFiles ?? [])
  // Tracked temporary/unexpected mutations cannot remain in the worktree:
  // later exact staging could otherwise carry their local contents into the
  // candidate. Restore only those tracked paths; untracked local outputs stay
  // available on disk for subsequent testing and Manual QA.
  restoreTrackedFinalTestLocalFiles(paths.worktreePath, audit)

  const remainingStatus = filterDeliveryRelevantDirtyFiles(
    paths.worktreePath,
    captureFinalTestDirtyFiles(paths.worktreePath),
    localOnlyPaths,
  )
  if (remainingStatus.length > 0) {
    throw new Error(`Manual QA checkpoint has unresolved delivery changes: ${remainingStatus.map(file => file.path).join(', ')}`)
  }

  const baseline = captureBaseline(paths.worktreePath, version, localOnlyPaths)
  writeReceiptJson(existingBaselinePath, baseline)
  return { baseline, checkpointCommit, candidateFiles, quarantinedFiles: [] }
}

function applyManualQaDriftDecision(
  ticketId: string,
  version: number,
  files: string[],
  actionId: string,
  decision: ManualQaDriftReceipt['decision'],
): ManualQaDriftReceipt {
  const paths = getTicketPaths(ticketId)
  const ticket = getTicketByRef(ticketId)
  if (!paths || !ticket) throw new Error(`Ticket workspace not initialized: ${ticketId}`)
  if (!actionId.trim()) throw new Error('Manual QA workspace decision requires an action ID')
  const receiptPath = driftReceiptPath(paths.ticketDir, actionId)
  const existing = readReceipt(receiptPath)
  if (existing) {
    if (existing.actionId !== actionId || existing.version !== version || existing.decision !== decision) {
      throw new Error('Manual QA workspace action ID was already used for another decision.')
    }
    appendDriftEvent(paths.ticketDir, ticket.externalId, existing)
    return existing
  }

  const requestedFiles = uniqueProjectPaths(files)
  const baseline = readBaseline(paths.ticketDir, version)
  const currentDirty = filterDeliveryRelevantDirtyFiles(
    paths.worktreePath,
    captureFinalTestDirtyFiles(paths.worktreePath),
    baseline.localOnlyPaths,
  )
  const currentDirtyPaths = new Set(currentDirty.map(file => file.path))
  const currentHead = runGit(paths.worktreePath, ['rev-parse', 'HEAD'])
  const committedDrift = captureCommittedDrift(paths.worktreePath, baseline.head, currentHead)
  const auditedFiles = new Set([...currentDirtyPaths, ...committedDrift.keys()])
  if (requestedFiles.some(file => !auditedFiles.has(file))) {
    throw new Error('Manual QA workspace decision may only include currently audited dirty files')
  }
  const unresolvedFiles = [...auditedFiles].filter(file => !requestedFiles.includes(file))
  if (unresolvedFiles.length > 0) {
    throw new Error(`Manual QA workspace decision must resolve every audited file: ${unresolvedFiles.join(', ')}`)
  }

  const previousHead = currentHead
  if (decision === 'include') {
    commitExactFiles(
      paths.worktreePath,
      requestedFiles,
      `${ticket.externalId}: include audited Manual QA workspace changes for v${version}`,
    )
  } else {
    quarantineFiles(paths.worktreePath, paths.ticketDir, version, requestedFiles)
    discardExactFiles(paths.worktreePath, requestedFiles, currentDirty)
    const committedFiles = requestedFiles.filter(file => committedDrift.has(file))
    const addedFiles = committedFiles.filter(file => committedDrift.get(file) === 'A')
    const restorableFiles = committedFiles.filter(file => committedDrift.get(file) !== 'A')
    if (restorableFiles.length > 0) {
      runGit(paths.worktreePath, [
        'restore',
        `--source=${baseline.head}`,
        '--staged',
        '--worktree',
        '--',
        ...restorableFiles.map(literalPathspec),
      ], true)
    }
    if (addedFiles.length > 0) {
      for (const file of addedFiles) {
        const target = resolve(paths.worktreePath, file)
        assertContained(paths.worktreePath, target)
        rmSync(target, { force: true, recursive: true })
      }
    }
    commitExactFiles(
      paths.worktreePath,
      committedFiles,
      `${ticket.externalId}: discard audited Manual QA workspace changes for v${version}`,
    )
  }

  const remainingStatus = filterDeliveryRelevantDirtyFiles(
    paths.worktreePath,
    captureFinalTestDirtyFiles(paths.worktreePath),
    baseline.localOnlyPaths,
  )
  if (remainingStatus.length > 0) {
    throw new Error(`Manual QA workspace still has unresolved drift: ${remainingStatus.map(file => file.path).join(', ')}`)
  }
  const nextBaseline = captureBaseline(paths.worktreePath, version, baseline.localOnlyPaths)
  writeReceiptJson(baselinePath(paths.ticketDir, version), nextBaseline)
  const receipt: ManualQaDriftReceipt = {
    schemaVersion: 1,
    actionId,
    version,
    decision,
    files: requestedFiles,
    previousHead,
    resultingHead: nextBaseline.head,
    createdAt: new Date().toISOString(),
  }
  writeReceiptJson(receiptPath, receipt)
  appendDriftEvent(paths.ticketDir, ticket.externalId, receipt)
  return receipt
}

export function includeManualQaWorkspaceDrift(
  ticketId: string,
  version: number,
  files: string[],
  actionId: string,
): ManualQaDriftReceipt {
  return applyManualQaDriftDecision(ticketId, version, files, actionId, 'include')
}

export function discardManualQaWorkspaceDrift(
  ticketId: string,
  version: number,
  files: string[],
  actionId: string,
): ManualQaDriftReceipt {
  return applyManualQaDriftDecision(ticketId, version, files, actionId, 'discard')
}
