import type { CommandSpec } from '@shared/commandSpec'
import type { ManualQaBeadOrigin } from '@/hooks/useTickets'
import { tryParseStructuredContent } from './structuredContent'

export const BEADS_APPROVAL_FOCUS_EVENT = 'beads-approval-focus'

/**
 * A bead exactly as it arrives from the server, with both the camelCase and
 * snake_case spellings the artifact has carried over time and every field
 * optional.
 *
 * Named `RawBead`, not `ParsedBead`: `BeadsApprovalEditor` exports a different
 * `ParsedBead` — the normalized shape its editor requires, with those fields
 * mandatory. Two contracts under one name would let a field added to either
 * side look interchangeable with the other.
 *
 * The artifact viewer declared this and its parser locally, and
 * `BeadsApprovalNavigator` reached for the same records through a bare
 * `bead as Record<string, unknown>` cast — so the outline and the detail view
 * could disagree about what a bead is.
 */
export interface RawBead {
  [key: string]: unknown
  id?: string
  title?: string
  prdRefs?: string[]
  prd_refs?: string[]
  description?: string
  contextGuidance?: string | {
    patterns?: string[]
    anti_patterns?: string[]
  }
  context_guidance?: string | {
    patterns?: string[]
    anti_patterns?: string[]
  }
  acceptanceCriteria?: string[]
  acceptance_criteria?: string[]
  tests?: string[]
  testCommands?: CommandSpec[]
  test_commands?: CommandSpec[]
  testCommandReason?: string
  test_command_reason?: string
  priority?: number
  status?: string
  issueType?: string
  issue_type?: string
  externalRef?: string
  external_ref?: string
  labels?: string[]
  dependencies?: {
    blocked_by?: string[]
    blocks?: string[]
  }
  targetFiles?: string[]
  target_files?: string[]
  notes?: string
  iteration?: number
  createdAt?: string
  created_at?: string
  updatedAt?: string
  updated_at?: string
  completedAt?: string
  completed_at?: string
  startedAt?: string
  started_at?: string
  beadStartCommit?: string | null
  bead_start_commit?: string | null
  qaOrigin?: ManualQaBeadOrigin | null
  qa_origin?: ManualQaBeadOrigin | null
}

export function parseBeadsArtifact(content: string): RawBead[] | null {
  const parsed = tryParseStructuredContent(content)
  if (Array.isArray(parsed)) {
    return parsed as RawBead[]
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray((parsed as { beads?: RawBead[] }).beads)) {
    return (parsed as { beads: RawBead[] }).beads
  }
  if (content.trim().startsWith('{')) {
    try {
      return content.trim().split('\n').map((line) => JSON.parse(line) as RawBead)
    } catch {
      return null
    }
  }
  return null
}
