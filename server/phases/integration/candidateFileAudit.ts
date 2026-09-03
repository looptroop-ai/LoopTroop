import type {
  CandidateFileAuditEntry,
  CandidateFileAuditReport,
  CandidateFileDecision,
} from '@shared/candidateFileAudit'
import { parseYamlOrJsonCandidate } from '../../structuredOutput/yamlUtils'
import { normalizeRepoScopedPath } from '../../git/repoScopedPath'

export { CANDIDATE_DIFF_ARTIFACT, CANDIDATE_FILE_AUDIT_ARTIFACT } from '@shared/candidateFileAudit'
export type { CandidateFileAuditEntry, CandidateFileAuditReport, CandidateFileDecision } from '@shared/candidateFileAudit'

export interface CandidateChangedFile {
  path: string
  status: string
}

interface CandidateFileAuditPayload {
  files?: unknown
}

const VALID_DECISIONS = new Set<CandidateFileDecision>(['include', 'exclude', 'review'])

const CANDIDATE_FILE_AUDIT_SEQUENCE_ITEM_PRIMARY_KEYS = {
  files: {
    primaryKey: 'path',
    childKeys: ['decision', 'reason'],
  },
} as const

export const CANDIDATE_FILE_AUDIT_SCHEMA_REMINDER = [
  'Return strict YAML only with exactly one top-level key: files.',
  '`files` must list every path from final_diff_name_status exactly once.',
  'Each file item must include exactly: path, decision, reason.',
  '`decision` must be one of: include, exclude, review.',
  '`reason` must be a non-empty string for exclude and review decisions, and should be concise for include decisions.',
  'Do not include markdown fences, prose outside YAML, or extra top-level keys.',
].join('\n')

export const normalizeCandidateAuditPath = normalizeRepoScopedPath

export function parseCandidateChangedFiles(nameStatus: string): CandidateChangedFile[] {
  const files: CandidateChangedFile[] = []
  const seen = new Set<string>()

  for (const rawLine of nameStatus.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    const parts = line.split(/\t+/).map((part) => part.trim()).filter(Boolean)
    if (parts.length < 2) continue
    const status = parts[0] ?? ''
    const rawPath = parts.at(-1) ?? ''
    const path = normalizeCandidateAuditPath(rawPath)
    if (!path || seen.has(path)) continue

    seen.add(path)
    files.push({ path, status })
  }

  return files
}

function normalizeReason(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed || fallback
}

export function parseCandidateFileAuditResponse(
  response: string,
  changedFiles: CandidateChangedFile[],
  repairWarnings: string[] = [],
): CandidateFileAuditEntry[] {
  const loaded = parseYamlOrJsonCandidate(response, {
    sequenceItemPrimaryKeys: CANDIDATE_FILE_AUDIT_SEQUENCE_ITEM_PRIMARY_KEYS,
    repairWarnings,
  }) as CandidateFileAuditPayload | null
  const parsed = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : null

  if (!parsed) {
    throw new Error('Candidate file audit output was not valid YAML.')
  }

  const keys = Object.keys(parsed as Record<string, unknown>)
  if (keys.some((key) => key !== 'files')) {
    throw new Error('Candidate file audit output included unsupported top-level keys.')
  }

  if (!Array.isArray(parsed.files)) {
    throw new Error('Candidate file audit output must include a files list.')
  }

  const allowedPaths = new Set(changedFiles.map((file) => file.path))
  const seen = new Set<string>()
  const entries: CandidateFileAuditEntry[] = []

  for (const [index, item] of parsed.files.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Candidate file audit entry ${index + 1} must be an object.`)
    }

    const record = item as Record<string, unknown>
    const path = typeof record.path === 'string' ? normalizeCandidateAuditPath(record.path) : null
    if (!path || !allowedPaths.has(path)) {
      throw new Error(`Candidate file audit entry ${index + 1} has an invalid or unknown path.`)
    }
    if (seen.has(path)) {
      throw new Error(`Candidate file audit listed ${path} more than once.`)
    }

    const decision = typeof record.decision === 'string' ? record.decision.trim() : ''
    if (!VALID_DECISIONS.has(decision as CandidateFileDecision)) {
      throw new Error(`Candidate file audit entry for ${path} has an invalid decision.`)
    }

    const normalizedDecision = decision as CandidateFileDecision
    const reason = normalizeReason(record.reason, normalizedDecision === 'include'
      ? 'Included because the audit did not identify it as an unrelated byproduct.'
      : '')
    if ((normalizedDecision === 'exclude' || normalizedDecision === 'review') && !reason) {
      throw new Error(`Candidate file audit entry for ${path} must include a reason.`)
    }

    seen.add(path)
    entries.push({ path, decision: normalizedDecision, reason })
  }

  const missing = [...allowedPaths].filter((path) => !seen.has(path))
  if (missing.length > 0) {
    throw new Error(`Candidate file audit did not classify every changed file: ${missing.join(', ')}`)
  }

  if (!entries.some((entry) => entry.decision === 'include' || entry.decision === 'review')) {
    throw new Error('Candidate file audit excluded every changed file.')
  }

  return entries
}

export function buildCandidateFileAuditPrompt(input: {
  fallbackTitle: string
  contextSections: string
  integrationReport: string
  finalTestReport: string
  diffStat: string
  diffNameStatus: string
  diffPatch: string
}): string {
  return [
    'You are auditing the final candidate files before LoopTroop pushes the draft pull request.',
    'Classify each changed file so the final PR includes intentional code changes and excludes unrelated byproducts.',
    '',
    'Rules:',
    '1. Exclude environment and local byproducts: LoopTroop internals, declared setup roots, ignored untracked files, caches, dependency installs, logs, coverage output, temp folders, local env/secrets, editor/OS files, and test reports that are not part of the requested code change.',
    '2. Be conservative with generated or tracked files. Do not exclude generated-looking or tracked files just because they are large. Keep them if the repo appears to commit them intentionally, if the ticket asked for them, if tests/build require them, or if the diff shows product artifacts such as committed bundles, lockfiles, generated API clients, migrations, snapshots, or release assets.',
    '3. Every exclusion needs evidence. For each excluded file, give a short reason based on path, git status, diff/stat, command provenance, repo config, .gitignore, or ticket scope. If you cannot explain why a file is unrelated, keep it with decision review.',
    '',
    CANDIDATE_FILE_AUDIT_SCHEMA_REMINDER,
    `If the ticket title matters for scope, use this exact title: "${input.fallbackTitle}"`,
    '',
    input.contextSections,
    '',
    '### integration_report',
    input.integrationReport.trim() || '[missing integration report]',
    '',
    '### final_test_report',
    input.finalTestReport.trim() || '[missing final test report]',
    '',
    '### final_diff_stat',
    input.diffStat.trim() || '[empty diff stat]',
    '',
    '### final_diff_name_status',
    input.diffNameStatus.trim() || '[empty diff name/status]',
    '',
    '### final_diff_patch',
    input.diffPatch.trim() || '[empty diff patch]',
  ].join('\n')
}

export function buildCandidateFileAuditReport(input: {
  status: 'passed' | 'fallback'
  baseCommit: string
  originalCandidateCommitSha: string
  candidateCommitSha: string | null
  entries: CandidateFileAuditEntry[]
  warnings?: string[]
}): CandidateFileAuditReport {
  const includedFiles = input.entries
    .filter((entry) => entry.decision === 'include' || entry.decision === 'review')
    .map((entry) => entry.path)
  const excludedFiles = input.entries
    .filter((entry) => entry.decision === 'exclude')
    .map((entry) => entry.path)
  const reviewedFiles = input.entries
    .filter((entry) => entry.decision === 'review')
    .map((entry) => entry.path)

  return {
    status: input.status,
    auditedAt: new Date().toISOString(),
    baseCommit: input.baseCommit,
    originalCandidateCommitSha: input.originalCandidateCommitSha,
    candidateCommitSha: input.candidateCommitSha,
    includedFiles,
    excludedFiles,
    reviewedFiles,
    entries: input.entries,
    stats: {
      totalFiles: input.entries.length,
      includedFiles: includedFiles.length,
      excludedFiles: excludedFiles.length,
      reviewedFiles: reviewedFiles.length,
    },
    message: excludedFiles.length > 0
      ? `Candidate file audit excluded ${excludedFiles.length} file(s) from the final PR.`
      : 'Candidate file audit kept all changed files in the final PR.',
    ...(input.warnings && input.warnings.length > 0 ? { warnings: input.warnings } : {}),
  }
}

export function buildIncludeAllCandidateFileAudit(input: {
  changedFiles: CandidateChangedFile[]
  baseCommit: string
  originalCandidateCommitSha: string
  candidateCommitSha: string | null
  warning: string
}): CandidateFileAuditReport {
  return buildCandidateFileAuditReport({
    status: 'fallback',
    baseCommit: input.baseCommit,
    originalCandidateCommitSha: input.originalCandidateCommitSha,
    candidateCommitSha: input.candidateCommitSha,
    entries: input.changedFiles.map((file) => ({
      path: file.path,
      decision: 'include',
      reason: 'Included because candidate-file audit fallback keeps files when classification is unavailable.',
    })),
    warnings: [input.warning],
  })
}
