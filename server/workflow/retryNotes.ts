import type { WorkflowPhaseId } from '@shared/workflowMeta'
import type { PromptPart } from '../opencode/types'
import { getTicketByRef } from '../storage/ticketQueries'
import { getLatestPhaseArtifact, upsertLatestPhaseArtifact } from '../storage/ticketArtifacts'

export const PHASE_RETRY_NOTE_ARTIFACT = 'user_retry_note'

export function canRetryWithExtraNote(ticketId: string, phase: string): boolean {
  const ticket = getTicketByRef(ticketId)
  return ticket?.previousStatus === phase && ticket.availableActions.includes('retry_with_note')
}

export function savePhaseRetryNote(ticketId: string, phase: WorkflowPhaseId, note: string | undefined, step?: string): void {
  if (note === undefined) {
    const artifact = getLatestPhaseArtifact(ticketId, PHASE_RETRY_NOTE_ARTIFACT, phase)
    if (!artifact) return
    try { if (JSON.parse(artifact.content)?.active === false) return } catch { /* Replace malformed optional guidance. */ }
  }
  upsertLatestPhaseArtifact(ticketId, PHASE_RETRY_NOTE_ARTIFACT, phase, JSON.stringify({ note: note ?? null, ...(step ? { step } : {}) }))
}

export function expirePhaseRetryNote(ticketId: string, phase: WorkflowPhaseId, step?: string): void {
  const artifact = getLatestPhaseArtifact(ticketId, PHASE_RETRY_NOTE_ARTIFACT, phase)
  if (!artifact) return
  let parsed: unknown
  try { parsed = JSON.parse(artifact.content) } catch { return }
  if (parsed && typeof parsed === 'object' && 'note' in parsed && typeof parsed.note === 'string'
    && (!('active' in parsed) || parsed.active !== false)
    && (step === undefined || !('step' in parsed) || parsed.step === step)) {
    upsertLatestPhaseArtifact(ticketId, PHASE_RETRY_NOTE_ARTIFACT, phase, JSON.stringify({ ...parsed, active: false }))
  }
}

export function readPhaseRetryNote(ticketId: string, phase: WorkflowPhaseId, readArtifact: typeof getLatestPhaseArtifact = getLatestPhaseArtifact, step?: string): string | undefined {
  const artifact = readArtifact(ticketId, PHASE_RETRY_NOTE_ARTIFACT, phase)
  if (!artifact) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(artifact.content) } catch { return undefined }
  if (parsed && typeof parsed === 'object' && 'note' in parsed && typeof parsed.note === 'string'
    && (!('active' in parsed) || parsed.active !== false)
    && (!('step' in parsed) || parsed.step === step)) return parsed.note
  return undefined
}

export function appendPhaseRetryNote(parts: PromptPart[], ticketId: string, phase: WorkflowPhaseId, readArtifact: typeof getLatestPhaseArtifact = getLatestPhaseArtifact, step?: string): PromptPart[] {
  // Coding already includes verbatim notes from the failed bead's own history.
  const note = phase === 'CODING' ? undefined : readPhaseRetryNote(ticketId, phase, readArtifact, step)
  if (note === undefined) return parts
  // A later per-model retry can add more recent guidance in the same phase.
  const memberNoteIndex = parts.findIndex(part => part.type === 'text' && part.content.startsWith('## User Retry Note\n'))
  if (parts.some(part => part.type === 'text' && part.content === `## User Retry Note\n${note}`)) return parts
  const index = memberNoteIndex < 0 ? parts.length : memberNoteIndex
  return [...parts.slice(0, index), { type: 'text', content: `## User Retry Note\n${note}` }, ...parts.slice(index)]
}
