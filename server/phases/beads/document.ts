import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { getTicketPaths } from '../../storage/tickets'
import { upsertLatestPhaseArtifact } from '../../storage/ticketArtifacts'
import { assertExpectedContentSha256 } from '../../lib/artifactApproval'
import { contentSha256 } from '../../lib/contentHash'
import { nowIso } from '../../lib/dateUtils'

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
  const lines = content.split('\n').filter((line) => line.trim() !== '')
  const beadCount = lines.length

  if (beadCount === 0) {
    throw new Error('Beads artifact is empty')
  }

  // Parse the complete JSONL document before semantic validation so a
  // malformed later line remains the primary error.
  const parsedRecords: Array<Record<string, unknown>> = []
  for (const [index, line] of lines.entries()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`Invalid JSON at bead line ${index + 1}`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Bead at line ${index + 1} is not a JSON object`)
    }
    parsedRecords.push(parsed as Record<string, unknown>)
  }

  for (const [index, record] of parsedRecords.entries()) {
    if (typeof record.id !== 'string' || !record.id.trim()) {
      throw new Error(`Bead at line ${index + 1} is missing a valid "id" field`)
    }
    if (typeof record.title !== 'string' || !record.title.trim()) {
      throw new Error(`Bead at line ${index + 1} is missing a valid "title" field`)
    }
    if (!Array.isArray(record.testCommands)) {
      throw new Error(`Bead ${record.id} is missing the testCommands list`)
    }
    for (const command of record.testCommands) {
      if (typeof command !== 'string' || !command.trim()) {
        throw new Error(`Bead ${record.id} contains an invalid test command`)
      }
    }
    if (record.testCommandReason !== undefined && (typeof record.testCommandReason !== 'string' || !record.testCommandReason.trim())) {
      throw new Error(`Bead ${record.id} contains an invalid testCommandReason`)
    }
    const testCommandReason = typeof record.testCommandReason === 'string' ? record.testCommandReason.trim() : ''
    if (record.testCommands.length === 0 && !testCommandReason) {
      throw new Error(`Bead ${record.id} requires testCommandReason when testCommands is empty`)
    }
    if (record.testCommands.length > 0 && testCommandReason) {
      throw new Error(`Bead ${record.id} may include testCommandReason only when testCommands is empty`)
    }
  }

  // Stamp createdAt on all beads at approval time
  const approvedAt = nowIso()
  const updatedLines = lines.map((line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>
    parsed.createdAt = approvedAt
    return JSON.stringify(parsed)
  })

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
