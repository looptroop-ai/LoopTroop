import { desc, eq, and, isNull } from 'drizzle-orm'
import { supportsRetryNote } from '@shared/aiRetry'
import type { WorkflowPhaseId } from '@shared/workflowMeta'
import { normalizeBlockedErrorDiagnostics } from '@shared/errorDiagnostics'
import type { PromptPart } from '../opencode/types'
import { ticketErrorOccurrences } from '../db/schema'
import { getTicketContext } from '../storage/ticketQueries'
import { getLatestPhaseArtifact, upsertLatestPhaseArtifact } from '../storage/ticketArtifacts'

export const PHASE_RETRY_NOTE_ARTIFACT = 'user_retry_note'

export function canRetryWithExtraNote(ticketId: string, phase: string): boolean {
  const context = getTicketContext(ticketId)
  if (!context) return false
  const occurrence = context.projectDb.select({ errorCodes: ticketErrorOccurrences.errorCodes, diagnosticDetails: ticketErrorOccurrences.diagnosticDetails })
    .from(ticketErrorOccurrences)
    .where(and(eq(ticketErrorOccurrences.ticketId, context.localTicketId), isNull(ticketErrorOccurrences.resolvedAt)))
    .orderBy(desc(ticketErrorOccurrences.id)).get()
  let codes: string[] = []
  if (occurrence?.errorCodes) {
    try {
      const parsed: unknown = JSON.parse(occurrence.errorCodes)
      if (Array.isArray(parsed)) codes = parsed.filter((code): code is string => typeof code === 'string')
    } catch { return false }
  }
  let diagnostics = null
  if (occurrence?.diagnosticDetails) {
    try { diagnostics = normalizeBlockedErrorDiagnostics(JSON.parse(occurrence.diagnosticDetails)) } catch { return false }
  }
  return supportsRetryNote(phase, codes, diagnostics)
}

export function savePhaseRetryNote(ticketId: string, phase: WorkflowPhaseId, note: string | undefined): void {
  if (note === undefined && !getLatestPhaseArtifact(ticketId, PHASE_RETRY_NOTE_ARTIFACT, phase)) return
  upsertLatestPhaseArtifact(ticketId, PHASE_RETRY_NOTE_ARTIFACT, phase, JSON.stringify({ note: note ?? null }))
}

export function readPhaseRetryNote(ticketId: string, phase: WorkflowPhaseId, readArtifact: typeof getLatestPhaseArtifact = getLatestPhaseArtifact): string | undefined {
  const artifact = readArtifact(ticketId, PHASE_RETRY_NOTE_ARTIFACT, phase)
  if (!artifact) return undefined
  const parsed: unknown = JSON.parse(artifact.content)
  if (parsed && typeof parsed === 'object' && 'note' in parsed && typeof parsed.note === 'string') return parsed.note
  return undefined
}

export function appendPhaseRetryNote(parts: PromptPart[], ticketId: string, phase: WorkflowPhaseId, readArtifact: typeof getLatestPhaseArtifact = getLatestPhaseArtifact): PromptPart[] {
  // Coding already includes verbatim notes from the failed bead's own history.
  const note = phase === 'CODING' ? undefined : readPhaseRetryNote(ticketId, phase, readArtifact)
  if (note === undefined) return parts
  // A later per-model retry can add more recent guidance in the same phase.
  const memberNoteIndex = parts.findIndex(part => part.type === 'text' && part.content.startsWith('## User Retry Note\n'))
  const index = memberNoteIndex < 0 ? parts.length : memberNoteIndex
  return [...parts.slice(0, index), { type: 'text', content: `## User Retry Note\n${note}` }, ...parts.slice(index)]
}
