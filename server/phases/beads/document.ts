import { TicketWorkspaceNotInitializedError } from '../../lib/workflowErrors'
import { relative } from 'node:path'
import { getTicketPaths, writeTicketFile } from '../../storage/tickets'
import { readFileNoFollowSync } from '../../io/readFile'
import { upsertLatestPhaseArtifact } from '../../storage/ticketArtifacts'
import { assertExpectedContentSha256 } from '../../lib/artifactApproval'
import { contentSha256 } from '../../lib/contentHash'
import { nowIso } from '../../lib/dateUtils'
import { commandSpecSchema } from '@shared/commandSpec'
import { parseJsonlContent } from '../../io/jsonl'
import {
  canonicalizeBeadAliases,
  describeBeadShapeProblem,
  deriveBeadBlocks,
  normalizeBeadCollections,
  validateBeadDependencyGraph,
} from './beadsFile'
import { isRecord } from '@shared/typeGuards'
import { resolveBeadStatus } from './types'

/**
 * The plan cannot be approved as written, and a person has to edit it.
 *
 * Distinct from a failure to read or write the file: this one is an answer
 * about the operator's own content, so the route reports it as a request
 * problem rather than a server fault. Typed rather than matched on the message,
 * which is what would drift the next time one of these is reworded.
 */
export class BeadPlanValidationError extends Error {}

const BEADS_APPROVAL_SNAPSHOT_ARTIFACT = 'approval_snapshot:beads'

/** Arrays the coding prompt and execution contract dereference without guards. */
const APPROVAL_REQUIRED_ARRAY_FIELDS = ['acceptanceCriteria', 'tests', 'targetFiles'] as const

function resolveBeadsPaths(ticketId: string) {
  const paths = getTicketPaths(ticketId)
  if (!paths) {
    throw new TicketWorkspaceNotInitializedError('Ticket workspace not initialized')
  }
  return paths
}

export function upsertBeadsApprovalSnapshot(ticketId: string, rawContent?: string): void {
  const content = rawContent ?? readFileNoFollowSync(resolveBeadsPaths(ticketId).beadsPath)
  upsertLatestPhaseArtifact(
    ticketId,
    BEADS_APPROVAL_SNAPSHOT_ARTIFACT,
    'WAITING_BEADS_APPROVAL',
    JSON.stringify({
      raw: content,
      content_sha256: contentSha256(content),
    }),
  )
}

export function approveBeadsDocument(ticketId: string, expectedContentSha256: string): {
  beadCount: number
  approvedAt: string
  contentSha256: string
} {
  const paths = resolveBeadsPaths(ticketId)
  const beadsPath = paths.beadsPath
  let content: string
  try {
    content = readFileNoFollowSync(beadsPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BeadPlanValidationError('Beads artifact not found')
    }
    throw error
  }
  const reviewedContentSha256 = assertExpectedContentSha256({
    artifactType: 'beads',
    currentContent: content,
    expectedContentSha256,
  })
  // Parsed through the shared reader so the line numbers reported here are the
  // ones in the file — the same numbers `GET /beads` reports as damaged, and
  // the same ones an operator opens their editor at. Filtering blank lines
  // first and numbering what survived made approval name a different line from
  // the read that sent them there.
  const { items, itemLines, malformedLines } = parseJsonlContent<unknown>(content, beadsPath)

  // Parse the complete JSONL document before semantic validation so a
  // malformed later line remains the primary error.
  if (malformedLines.length > 0) {
    throw new BeadPlanValidationError(`Invalid JSON at bead line ${malformedLines[0]}`)
  }

  const beadCount = items.length
  if (beadCount === 0) {
    throw new BeadPlanValidationError('Beads artifact is empty')
  }

  const parsedRecords: Array<Record<string, unknown>> = []
  for (const [index, parsed] of items.entries()) {
    const line = itemLines[index] ?? index + 1
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BeadPlanValidationError(`Bead at line ${line} is not a JSON object`)
    }
    const canonical = normalizeBeadCollections(canonicalizeBeadAliases(parsed as Record<string, unknown>))
    parsedRecords.push(canonical)
  }

  const firstLineById = new Map<string, number>()
  for (const [index, record] of parsedRecords.entries()) {
    // The file's line, like every other number reported about this file. The
    // record's position counts only what parsed, so with a blank line above it
    // approval named a line the operator's editor does not hold that bead on.
    const line = itemLines[index] ?? index + 1
    const shapeProblem = describeBeadShapeProblem(record)
    if (shapeProblem) throw new BeadPlanValidationError(`Bead at line ${line} ${shapeProblem}`)
    if (typeof record.status !== 'string' || !resolveBeadStatus(record.status)) {
      if (record.status === undefined) {
        throw new BeadPlanValidationError(`Bead at line ${line} is missing a valid "status" field`)
      }
      throw new BeadPlanValidationError(`Bead at line ${line} has an unrecognised status ${JSON.stringify(record.status)}`)
    }
    if (record.priority === undefined) {
      throw new BeadPlanValidationError(`Bead at line ${line} is missing a valid "priority" field`)
    }
    if (typeof record.title !== 'string' || !record.title.trim()) {
      throw new BeadPlanValidationError(`Bead at line ${line} is missing a valid "title" field`)
    }
    const firstLine = firstLineById.get(record.id as string)
    if (firstLine !== undefined) {
      throw new BeadPlanValidationError(`Bead at line ${line} has duplicate id ${JSON.stringify(record.id)} (first seen at line ${firstLine})`)
    }
    firstLineById.set(record.id as string, line)
    for (const field of APPROVAL_REQUIRED_ARRAY_FIELDS) {
      const value = record[field]
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new BeadPlanValidationError(`Bead ${record.id} is missing a valid ${field} list`)
      }
    }
    if (!Array.isArray(record.testCommands)) {
      throw new BeadPlanValidationError(`Bead ${record.id} is missing the testCommands list`)
    }
    for (const command of record.testCommands) {
      if (!commandSpecSchema.safeParse(command).success) {
        throw new BeadPlanValidationError(`Bead ${record.id} contains an invalid test command`)
      }
    }
    if (record.testCommandReason !== undefined && (typeof record.testCommandReason !== 'string' || !record.testCommandReason.trim())) {
      throw new BeadPlanValidationError(`Bead ${record.id} contains an invalid testCommandReason`)
    }
    const testCommandReason = typeof record.testCommandReason === 'string' ? record.testCommandReason.trim() : ''
    if (record.testCommands.length === 0 && !testCommandReason) {
      throw new BeadPlanValidationError(`Bead ${record.id} requires testCommandReason when testCommands is empty`)
    }
    if (record.testCommands.length > 0 && testCommandReason) {
      throw new BeadPlanValidationError(`Bead ${record.id} may include testCommandReason only when testCommands is empty`)
    }
  }

  // blocked_by is the scheduler's authoritative edge. Rebuild the inverse
  // rather than trusting a stale `blocks` list from a human edit, then run the
  // same dangling/self/cycle checks the pre-flight contract reports.
  const normalizedRecords = parsedRecords.map((record) => {
    if (typeof record.status !== 'string') return record
    return { ...record, status: resolveBeadStatus(record.status) }
  })
  const graphRecords = deriveBeadBlocks(normalizedRecords)
  const graphErrors = validateBeadDependencyGraph(graphRecords.flatMap((record) => {
    if (!isRecord(record.dependencies) || !Array.isArray(record.dependencies.blocked_by) || !Array.isArray(record.dependencies.blocks)) {
      return []
    }
    return [{
      id: String(record.id),
      dependencies: {
        blocked_by: record.dependencies.blocked_by.filter((dependency): dependency is string => typeof dependency === 'string'),
        blocks: record.dependencies.blocks.filter((dependency): dependency is string => typeof dependency === 'string'),
      },
    }]
  }))
  if (graphErrors.length > 0) {
    throw new BeadPlanValidationError(graphErrors.join('; '))
  }

  // Stamp createdAt on all beads at approval time
  const approvedAt = nowIso()
  // Rewritten from the records already parsed above rather than re-parsing the
  // text: two passes over the same lines is two chances to disagree about what
  // the file holds.
  const updatedLines = graphRecords.map((record) => JSON.stringify({ ...record, createdAt: approvedAt }))

  const updatedContent = updatedLines.join('\n') + '\n'
  writeTicketFile(ticketId, relative(paths.ticketDir, beadsPath), updatedContent)

  upsertBeadsApprovalSnapshot(ticketId, updatedContent)
  const approvalReceipt = JSON.stringify({
    approved_by: 'user',
    approved_at: approvedAt,
    artifact_type: 'beads',
    phase: 'WAITING_BEADS_APPROVAL',
    bead_count: beadCount,
    content_sha256: reviewedContentSha256,
  })

  upsertLatestPhaseArtifact(ticketId, 'approval_receipt', 'WAITING_BEADS_APPROVAL', approvalReceipt)

  return { beadCount, approvedAt, contentSha256: reviewedContentSha256 }
}
