import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { getTicketPaths } from '../../storage/tickets'
import { upsertLatestPhaseArtifact } from '../../storage/ticketArtifacts'
import { assertExpectedContentSha256 } from '../../lib/artifactApproval'
import { contentSha256 } from '../../lib/contentHash'
import { nowIso } from '../../lib/dateUtils'
import { commandSpecSchema } from '@shared/commandSpec'
import { parseJsonlContent } from '../../io/jsonl'

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

function resolveBeadsPath(ticketId: string): string {
  const paths = getTicketPaths(ticketId)
  if (!paths) {
    throw new Error('Ticket workspace not initialized')
  }
  return paths.beadsPath
}

export function upsertBeadsApprovalSnapshot(ticketId: string, rawContent?: string): void {
  const content = rawContent ?? readFileSync(resolveBeadsPath(ticketId), 'utf-8')
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
  const beadsPath = resolveBeadsPath(ticketId)
  if (!existsSync(beadsPath)) {
    throw new Error('Beads artifact not found')
  }

  const content = readFileSync(beadsPath, 'utf-8')
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
    parsedRecords.push(parsed as Record<string, unknown>)
  }

  for (const [index, record] of parsedRecords.entries()) {
    // The file's line, like every other number reported about this file. The
    // record's position counts only what parsed, so with a blank line above it
    // approval named a line the operator's editor does not hold that bead on.
    const line = itemLines[index] ?? index + 1
    if (typeof record.id !== 'string' || !record.id.trim()) {
      throw new BeadPlanValidationError(`Bead at line ${line} is missing a valid "id" field`)
    }
    if (typeof record.title !== 'string' || !record.title.trim()) {
      throw new BeadPlanValidationError(`Bead at line ${line} is missing a valid "title" field`)
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

  // Stamp createdAt on all beads at approval time
  const approvedAt = nowIso()
  // Rewritten from the records already parsed above rather than re-parsing the
  // text: two passes over the same lines is two chances to disagree about what
  // the file holds.
  const updatedLines = parsedRecords.map((record) => JSON.stringify({ ...record, createdAt: approvedAt }))

  const updatedContent = updatedLines.join('\n') + '\n'
  writeFileSync(beadsPath, updatedContent, 'utf-8')

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
