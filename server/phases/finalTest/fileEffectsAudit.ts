import { getLatestPhaseArtifact } from '../../storage/tickets'
import { literalPathspec, REPO_SCOPE_PATHSPECS } from '../../git/pathspecs'
import { normalizeRepoScopedPath, uniqueRepoScopedPaths } from '../../git/repoScopedPath'
import { runGitSync } from '../../git/runCommand'
import { parseGitStatusPorcelainZ } from '../../git/statusPorcelain'
import { classifyWorktreePath } from '../../git/worktreeChanges'
import {
  FINAL_TEST_FILE_EFFECTS_AUDIT_ARTIFACT,
  type FinalTestFileEffect,
  type FinalTestFileEffectIntent,
} from '@shared/finalTestFileEffects'

export { FINAL_TEST_FILE_EFFECTS_AUDIT_ARTIFACT, type FinalTestFileEffect, type FinalTestFileEffectIntent }

export interface FinalTestDirtyFile {
  path: string
  indexStatus: string
  worktreeStatus: string
  rawStatus: string
  untracked: boolean
  contentSignature: string | null
}

export type FinalTestFileEffectDisposition = 'candidate' | 'local_only'

export type FinalTestFileEffectResolutionReason =
  | 'declared_candidate'
  | 'declared_temporary'
  | 'declared_unexpected'
  | 'tracked'
  | 'setup_temporary'
  | 'generated_noise'
  | 'undeclared_fallback'

export interface FinalTestResolvedFileEffect {
  path: string
  disposition: FinalTestFileEffectDisposition
  reason: FinalTestFileEffectResolutionReason
  detail?: string
  warning?: string
}

export interface FinalTestFileEffectsAudit {
  status: 'passed'
  capturedAt: string
  baselineDirtyFiles: FinalTestDirtyFile[]
  dirtyFilesAfterTesting: FinalTestDirtyFile[]
  producedByFinalTesting: FinalTestDirtyFile[]
  declaredEffects: FinalTestFileEffect[]
  resolvedEffects: FinalTestResolvedFileEffect[]
  candidateFiles: string[]
  localOnlyFiles: string[]
  classificationRequiredFiles: string[]
  classificationRetry: {
    status: 'not_needed' | 'resolved' | 'fallback'
    requestedFiles: string[]
    warning?: string
  }
  temporaryFiles: string[]
  unexpectedFiles: string[]
  warnings: string[]
  message: string
}

export interface FinalTestCandidateResolution {
  ok: true
  candidateFiles: string[]
  audit?: FinalTestFileEffectsAudit
}

const normalizeAuditPath = normalizeRepoScopedPath
const uniqueNormalizedPaths = uniqueRepoScopedPaths

function getContentSignature(worktreePath: string, filePath: string): string | null {
  // Not a pathspec: `hash-object` opens the file by name, and a `:(literal)`
  // prefix makes it look for a file called that. Verified — it fails with
  // "could not open ':(literal)…'". `check-ignore` rejects the magic outright.
  const result = runGitSync(worktreePath, ['hash-object', '--no-filters', '--', filePath])
  return result.ok ? result.stdout || null : null
}

function parseGitStatusPorcelain(stdout: string, worktreePath: string): FinalTestDirtyFile[] {
  const dirtyFiles: FinalTestDirtyFile[] = []

  // A rename reaches the audit as the destination plus a deletion of the
  // original, so neither half of the move goes unrecorded.
  for (const record of parseGitStatusPorcelainZ(stdout)) {
    const { indexStatus, worktreeStatus } = record
    const path = normalizeAuditPath(record.path)
    if (!path) continue

    dirtyFiles.push({
      path,
      indexStatus,
      worktreeStatus,
      rawStatus: `${indexStatus}${worktreeStatus}`,
      untracked: indexStatus === '?' && worktreeStatus === '?',
      contentSignature: getContentSignature(worktreePath, path),
    })
  }

  return dirtyFiles
}

export function captureFinalTestDirtyFiles(
  worktreePath: string,
  explicitPaths: string[] = [],
): FinalTestDirtyFile[] {
  const result = runGitSync(worktreePath, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    ...REPO_SCOPE_PATHSPECS,
  ], { trimOutput: false })

  if (!result.ok) {
    throw new Error(`Failed to capture final-test dirty files: ${result.errorDetail}`)
  }

  const dirtyFiles = parseGitStatusPorcelain(result.stdout, worktreePath)
  const seenPaths = new Set(dirtyFiles.map((file) => file.path))

  // Git omits ignored untracked files from normal status output. An exact
  // model-declared effect is explicit delivery intent, so capture that path
  // directly and let the audit apply the declaration before local-noise rules.
  for (const path of uniqueNormalizedPaths(explicitPaths)) {
    if (seenPaths.has(path)) continue
    const contentSignature = getContentSignature(worktreePath, path)
    if (!contentSignature) continue
    const tracked = runGitSync(worktreePath, ['ls-files', '--error-unmatch', '--', literalPathspec(path)]).ok
    dirtyFiles.push({
      path,
      indexStatus: tracked ? ' ' : '?',
      worktreeStatus: tracked ? 'M' : '?',
      rawStatus: tracked ? ' M' : '??',
      untracked: !tracked,
      contentSignature,
    })
  }

  return dirtyFiles
}

function normalizeDeclaredEffects(effects: FinalTestFileEffect[]): FinalTestFileEffect[] {
  const normalizedEffects: FinalTestFileEffect[] = []
  const seen = new Set<string>()

  for (const effect of effects) {
    const path = normalizeAuditPath(effect.path)
    if (!path || seen.has(path)) continue
    seen.add(path)
    normalizedEffects.push({
      path,
      intent: effect.intent,
      ...(effect.reason ? { reason: effect.reason } : {}),
    })
  }

  return normalizedEffects
}

function hasDirtyFileChanged(before: FinalTestDirtyFile | undefined, after: FinalTestDirtyFile): boolean {
  if (!before) return true
  return before.rawStatus !== after.rawStatus || before.contentSignature !== after.contentSignature
}

export function buildFinalTestFileEffectsAudit(input: {
  baselineDirtyFiles: FinalTestDirtyFile[]
  dirtyFilesAfterTesting: FinalTestDirtyFile[]
  declaredEffects: FinalTestFileEffect[]
  setupExcludedRoots?: string[]
  classificationRetry?: FinalTestFileEffectsAudit['classificationRetry']
  capturedAt?: string
}): FinalTestFileEffectsAudit {
  const baselineByPath = new Map(input.baselineDirtyFiles.map((file) => [file.path, file]))
  const producedByFinalTesting = input.dirtyFilesAfterTesting
    .filter((file) => hasDirtyFileChanged(baselineByPath.get(file.path), file))
  const declaredEffects = normalizeDeclaredEffects(input.declaredEffects)
  const effectsByPath = new Map(declaredEffects.map((effect) => [effect.path, effect]))

  const resolvedEffects: FinalTestResolvedFileEffect[] = []
  const temporaryFiles: string[] = []
  const unexpectedFiles: string[] = []

  for (const dirtyFile of producedByFinalTesting) {
    const effect = effectsByPath.get(dirtyFile.path)
    if (effect?.intent === 'candidate') {
      resolvedEffects.push({
        path: dirtyFile.path,
        disposition: 'candidate',
        reason: 'declared_candidate',
        ...(effect.reason ? { detail: effect.reason } : {}),
      })
      continue
    }
    if (effect?.intent === 'temporary') {
      temporaryFiles.push(dirtyFile.path)
      resolvedEffects.push({
        path: dirtyFile.path,
        disposition: 'local_only',
        reason: 'declared_temporary',
        ...(effect.reason ? { detail: effect.reason } : {}),
      })
      continue
    }
    if (effect?.intent === 'unexpected') {
      unexpectedFiles.push(dirtyFile.path)
      resolvedEffects.push({
        path: dirtyFile.path,
        disposition: 'local_only',
        reason: 'declared_unexpected',
        ...(effect.reason ? { detail: effect.reason } : {}),
      })
      continue
    }

    if (!dirtyFile.untracked) {
      resolvedEffects.push({
        path: dirtyFile.path,
        disposition: 'candidate',
        reason: 'tracked',
      })
      continue
    }

    const classification = classifyWorktreePath(dirtyFile.path, {
      setupExcludedRoots: input.setupExcludedRoots,
      untracked: true,
    })
    if (classification.category === 'setupExcluded') {
      resolvedEffects.push({
        path: dirtyFile.path,
        disposition: 'local_only',
        reason: 'setup_temporary',
      })
      continue
    }
    if (classification.category === 'generatedNoise') {
      resolvedEffects.push({
        path: dirtyFile.path,
        disposition: 'local_only',
        reason: 'generated_noise',
        ...(classification.generatedNoisePattern ? { detail: classification.generatedNoisePattern } : {}),
      })
      continue
    }

    resolvedEffects.push({
      path: dirtyFile.path,
      disposition: 'local_only',
      reason: 'undeclared_fallback',
      warning: `Undeclared untracked file was kept locally and excluded from delivery: ${dirtyFile.path}`,
    })
  }

  const candidateFiles = uniqueNormalizedPaths(
    resolvedEffects
      .filter((effect) => effect.disposition === 'candidate')
      .map((effect) => effect.path),
  )
  const localOnlyFiles = uniqueNormalizedPaths(
    resolvedEffects
      .filter((effect) => effect.disposition === 'local_only')
      .map((effect) => effect.path),
  )
  const warnings = resolvedEffects
    .map((effect) => effect.warning)
    .filter((warning): warning is string => Boolean(warning))
  const classificationRequiredFiles = uniqueNormalizedPaths(
    resolvedEffects
      .filter((effect) => effect.reason === 'undeclared_fallback')
      .map((effect) => effect.path),
  )

  return {
    status: 'passed',
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    baselineDirtyFiles: input.baselineDirtyFiles,
    dirtyFilesAfterTesting: input.dirtyFilesAfterTesting,
    producedByFinalTesting,
    declaredEffects,
    resolvedEffects,
    candidateFiles,
    localOnlyFiles,
    classificationRequiredFiles,
    classificationRetry: input.classificationRetry ?? {
      status: classificationRequiredFiles.length > 0 ? 'fallback' : 'not_needed',
      requestedFiles: classificationRequiredFiles,
    },
    temporaryFiles: uniqueNormalizedPaths(temporaryFiles),
    unexpectedFiles: uniqueNormalizedPaths(unexpectedFiles),
    warnings,
    message: warnings.length > 0
      ? `Final-test file effects were resolved with ${warnings.length} warning(s).`
      : 'Final-test file effects were fully resolved.',
  }
}

function parseJsonArtifact<T>(content: string): T | null {
  try {
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isFinalTestResolvedFileEffect(value: unknown): value is FinalTestResolvedFileEffect {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.path === 'string'
    && (record.disposition === 'candidate' || record.disposition === 'local_only')
    && (
      record.reason === 'declared_candidate'
      || record.reason === 'declared_temporary'
      || record.reason === 'declared_unexpected'
      || record.reason === 'tracked'
      || record.reason === 'setup_temporary'
      || record.reason === 'generated_noise'
      || record.reason === 'undeclared_fallback'
    )
  )
}

function isFinalTestClassificationRetry(
  value: unknown,
): value is FinalTestFileEffectsAudit['classificationRetry'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    (
      record.status === 'not_needed'
      || record.status === 'resolved'
      || record.status === 'fallback'
    )
    && isStringArray(record.requestedFiles)
    && (record.warning === undefined || typeof record.warning === 'string')
  )
}

function isFinalTestFileEffectsAudit(value: unknown): value is FinalTestFileEffectsAudit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.status === 'passed'
    && Array.isArray(record.baselineDirtyFiles)
    && Array.isArray(record.dirtyFilesAfterTesting)
    && Array.isArray(record.producedByFinalTesting)
    && Array.isArray(record.declaredEffects)
    && Array.isArray(record.resolvedEffects)
    && record.resolvedEffects.every(isFinalTestResolvedFileEffect)
    && isStringArray(record.candidateFiles)
    && isStringArray(record.localOnlyFiles)
    && isStringArray(record.classificationRequiredFiles)
    && isFinalTestClassificationRetry(record.classificationRetry)
    && isStringArray(record.temporaryFiles)
    && isStringArray(record.unexpectedFiles)
    && isStringArray(record.warnings)
  )
}

export function readLatestFinalTestFileEffectsAudit(ticketId: string): FinalTestFileEffectsAudit | null {
  const artifact = getLatestPhaseArtifact(ticketId, FINAL_TEST_FILE_EFFECTS_AUDIT_ARTIFACT, 'RUNNING_FINAL_TEST')
  const parsed = artifact ? parseJsonArtifact<FinalTestFileEffectsAudit>(artifact.content) : null
  return isFinalTestFileEffectsAudit(parsed) ? parsed : null
}

export function resolveFinalTestCandidateFiles(ticketId: string): FinalTestCandidateResolution {
  const audit = readLatestFinalTestFileEffectsAudit(ticketId)
  if (!audit) {
    return { ok: true, candidateFiles: [] }
  }

  return {
    ok: true,
    candidateFiles: uniqueNormalizedPaths(audit.candidateFiles),
    audit,
  }
}

export function restoreTrackedFinalTestLocalFiles(
  worktreePath: string,
  audit: FinalTestFileEffectsAudit | undefined,
): string[] {
  if (!audit) return []
  const producedByPath = new Map(audit.producedByFinalTesting.map((file) => [file.path, file]))
  const trackedLocalOnlyFiles = uniqueNormalizedPaths(audit.localOnlyFiles)
    .filter((file) => producedByPath.has(file) && !producedByPath.get(file)?.untracked)
  if (trackedLocalOnlyFiles.length === 0) return []

  const result = runGitSync(worktreePath, [
    'restore',
    '--staged',
    '--worktree',
    '--',
    ...trackedLocalOnlyFiles.map(literalPathspec),
  ])
  if (!result.ok) {
    throw new Error(`Failed to restore tracked local-only final-test file(s): ${result.errorDetail}`)
  }
  return trackedLocalOnlyFiles
}
