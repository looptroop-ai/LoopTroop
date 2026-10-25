import { normalizeRepoScopedPath } from '../git/repoScopedPath'
import { isRecord } from '../../shared/typeGuards'

interface CoverageRevisionCheckpoint {
  candidateVersion: number
  refinedContent: string
  auditResult: { envelope: { status: 'gaps'; gaps: string[] } }
}

interface CandidateFileAuditCheckpoint {
  baseCommit: string
  candidateCommitSha: string
  status: 'passed' | 'fallback'
  includedFiles: string[]
  excludedFiles: string[]
  entries: Array<{ path: string; decision: 'include' | 'exclude' | 'review'; reason: string }>
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')
}

function hasSameUniqueMembers(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length
    && new Set(actual).size === actual.length
    && expected.length === new Set(expected).size
    && actual.every((entry) => expected.includes(entry))
}

export function isCoverageRevisionCheckpoint(value: unknown): value is CoverageRevisionCheckpoint {
  if (!isRecord(value) || !Number.isInteger(value.candidateVersion) || (value.candidateVersion as number) < 1
    || typeof value.refinedContent !== 'string' || value.refinedContent.trim().length === 0
    || !isRecord(value.auditResult) || !isRecord(value.auditResult.envelope)) return false

  const envelope = value.auditResult.envelope
  return envelope.status === 'gaps'
    && Array.isArray(envelope.gaps)
    && envelope.gaps.length > 0
    && envelope.gaps.every((gap) => typeof gap === 'string')
}

export function isCandidateFileAuditCheckpoint(
  value: unknown,
  expected: { baseCommit: string; candidateCommitSha: string },
): value is CandidateFileAuditCheckpoint {
  if (!isRecord(value)
    || value.baseCommit !== expected.baseCommit
    || value.candidateCommitSha !== expected.candidateCommitSha
    || (value.status !== 'passed' && value.status !== 'fallback')
    || !isStringArray(value.includedFiles)
    || !isStringArray(value.excludedFiles)
    || !Array.isArray(value.entries)) return false

  const entries = value.entries
  if (!entries.every((entry): entry is Record<string, unknown> => isRecord(entry)
    && typeof entry.path === 'string'
    && normalizeRepoScopedPath(entry.path) === entry.path
    && (entry.decision === 'include' || entry.decision === 'exclude' || entry.decision === 'review')
    && typeof entry.reason === 'string' && entry.reason.trim().length > 0)) return false

  const entryPaths = entries.map((entry) => entry.path as string)
  if (new Set(entryPaths).size !== entryPaths.length) return false

  const included = entries.filter((entry) => entry.decision !== 'exclude').map((entry) => entry.path as string)
  const excluded = entries.filter((entry) => entry.decision === 'exclude').map((entry) => entry.path as string)
  return hasSameUniqueMembers(value.includedFiles, included)
    && hasSameUniqueMembers(value.excludedFiles, excluded)
}
