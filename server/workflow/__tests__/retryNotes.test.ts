import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptPart } from '../../opencode/types'

const { artifacts, context, lookup, upsert } = vi.hoisted(() => ({
  artifacts: new Map<string, { content: string }>(),
  context: vi.fn(),
  lookup: vi.fn(),
  upsert: vi.fn(),
}))
vi.mock('../../storage/ticketArtifacts', () => ({ getLatestPhaseArtifact: lookup, upsertLatestPhaseArtifact: upsert }))
vi.mock('../../storage/ticketQueries', () => ({ getTicketByRef: context }))

import { appendPhaseRetryNote, recordSessionRetryGuidance, hasSessionRetryGuidance, canRetryWithExtraNote, expirePhaseRetryNote, PHASE_RETRY_NOTE_ARTIFACT, readPhaseRetryNote, savePhaseRetryNote } from '../retryNotes'

describe('phase retry notes', () => {
  beforeEach(() => {
    artifacts.clear()
    lookup.mockImplementation((ticketId, kind, phase) => artifacts.get(`${ticketId}:${phase}:${kind}`))
    upsert.mockImplementation((ticketId, kind, phase, content) => { artifacts.set(`${ticketId}:${phase}:${kind}`, { content }) })
  })

  it('preserves literal instructions and keeps them scoped to their ticket and phase', () => {
    const note = '  Keep this path: C:\\Users\\Example\\config.json\nDo not change the approved requirements.  '
    savePhaseRetryNote('1:TEST-1', 'EXPANDING_BEADS', note)
    expect(readPhaseRetryNote('1:TEST-1', 'EXPANDING_BEADS')).toBe(note)
    expect(readPhaseRetryNote('1:TEST-2', 'EXPANDING_BEADS')).toBeUndefined()
    expect(readPhaseRetryNote('1:TEST-1', 'REFINING_PRD')).toBeUndefined()
    const parts: PromptPart[] = [{ type: 'text', content: 'Saved input' }]
    expect(appendPhaseRetryNote(parts, '1:TEST-1', 'EXPANDING_BEADS')).toEqual([
      ...parts, { type: 'text', content: `## User Retry Note\n${note}` },
    ])
    expect(parts).toHaveLength(1)
  })

  it('clears rejected instructions without creating empty artifacts for ordinary retries', () => {
    savePhaseRetryNote('1:TEST-1', 'REFINING_PRD', undefined)
    expect(upsert).not.toHaveBeenCalled()
    savePhaseRetryNote('1:TEST-1', 'REFINING_PRD', 'Rejected dispatch')
    savePhaseRetryNote('1:TEST-1', 'REFINING_PRD', undefined)
    expect(readPhaseRetryNote('1:TEST-1', 'REFINING_PRD')).toBeUndefined()
    expect(JSON.parse(artifacts.get(`1:TEST-1:REFINING_PRD:${PHASE_RETRY_NOTE_ARTIFACT}`)!.content))
      .toEqual({ note: 'Rejected dispatch', active: false })
  })

  it('retains session guidance evidence after the note expires without attributing it to other sessions', () => {
    savePhaseRetryNote('1:TEST-1', 'DRAFTING_BEADS', 'Keep this guidance')
    recordSessionRetryGuidance('1:TEST-1', 'DRAFTING_BEADS', 'guided-session', [{ type: 'text', content: '## User Retry Note\nKeep this guidance' }])
    expirePhaseRetryNote('1:TEST-1', 'DRAFTING_BEADS')
    expect(readPhaseRetryNote('1:TEST-1', 'DRAFTING_BEADS')).toBeUndefined()
    expect(hasSessionRetryGuidance('1:TEST-1', 'DRAFTING_BEADS', 'guided-session')).toBe(true)
    expect(hasSessionRetryGuidance('1:TEST-1', 'DRAFTING_BEADS', 'fresh-session')).toBe(false)
    recordSessionRetryGuidance('1:TEST-1', 'DRAFTING_BEADS', 'fresh-session', [{ type: 'text', content: 'continue please' }])
    expect(hasSessionRetryGuidance('1:TEST-1', 'DRAFTING_BEADS', 'fresh-session')).toBe(false)
  })

  it('leaves coding notes to the existing per-bead history', () => {
    savePhaseRetryNote('1:TEST-1', 'CODING', 'Do not duplicate this')
    const parts: PromptPart[] = [{ type: 'text', content: 'Bead and its retry notes' }]
    expect(appendPhaseRetryNote(parts, '1:TEST-1', 'CODING')).toBe(parts)
    expect(appendPhaseRetryNote(parts, '1:TEST-1', 'RUNNING_FINAL_TEST')).toBe(parts)
  })

  it('expires successful guidance while retaining the submitted text as history', () => {
    savePhaseRetryNote('1:TEST-1', 'RUNNING_FINAL_TEST', 'Check the reported failure')
    expirePhaseRetryNote('1:TEST-1', 'RUNNING_FINAL_TEST')
    expect(readPhaseRetryNote('1:TEST-1', 'RUNNING_FINAL_TEST')).toBeUndefined()
    expect(JSON.parse(artifacts.get(`1:TEST-1:RUNNING_FINAL_TEST:${PHASE_RETRY_NOTE_ARTIFACT}`)!.content))
      .toEqual({ note: 'Check the reported failure', active: false })
    upsert.mockClear()
    expirePhaseRetryNote('1:TEST-1', 'RUNNING_FINAL_TEST')
    expirePhaseRetryNote('1:TEST-2', 'RUNNING_FINAL_TEST')
    expect(upsert).not.toHaveBeenCalled()
  })

  it('expires only the recovered substep and keeps history through later ordinary retries', () => {
    savePhaseRetryNote('1:TEST-1', 'VERIFYING_PRD_COVERAGE', 'Resolve the reported gap', 'revision')
    expirePhaseRetryNote('1:TEST-1', 'VERIFYING_PRD_COVERAGE', 'audit')
    expect(readPhaseRetryNote('1:TEST-1', 'VERIFYING_PRD_COVERAGE', undefined, 'revision')).toBe('Resolve the reported gap')
    expirePhaseRetryNote('1:TEST-1', 'VERIFYING_PRD_COVERAGE', 'revision')
    const retained = artifacts.get(`1:TEST-1:VERIFYING_PRD_COVERAGE:${PHASE_RETRY_NOTE_ARTIFACT}`)!.content
    savePhaseRetryNote('1:TEST-1', 'VERIFYING_PRD_COVERAGE', undefined)
    expect(artifacts.get(`1:TEST-1:VERIFYING_PRD_COVERAGE:${PHASE_RETRY_NOTE_ARTIFACT}`)!.content).toBe(retained)
    expect(appendPhaseRetryNote([], '1:TEST-1', 'VERIFYING_PRD_COVERAGE', undefined, 'revision')).toEqual([])
  })

  it('applies substep guidance only to the failed substep and avoids duplicate member notes', () => {
    savePhaseRetryNote('1:TEST-1', 'CREATING_PULL_REQUEST', 'Explain the change', 'pull_request_draft')
    const parts: PromptPart[] = [{ type: 'text', content: 'Saved inputs' }]
    expect(appendPhaseRetryNote(parts, '1:TEST-1', 'CREATING_PULL_REQUEST', undefined, 'candidate_file_audit')).toBe(parts)
    expect(appendPhaseRetryNote(parts, '1:TEST-1', 'CREATING_PULL_REQUEST', undefined, 'pull_request_draft')).toHaveLength(2)
    const withMember: PromptPart[] = [...parts, { type: 'text', content: '## User Retry Note\nExplain the change' }]
    expect(appendPhaseRetryNote(withMember, '1:TEST-1', 'CREATING_PULL_REQUEST', undefined, 'pull_request_draft')).toBe(withMember)
  })

  it('ignores damaged optional note data instead of breaking every prompt', () => {
    artifacts.set(`1:TEST-1:REFINING_PRD:${PHASE_RETRY_NOTE_ARTIFACT}`, { content: 'invalid json' })
    expect(readPhaseRetryNote('1:TEST-1', 'REFINING_PRD')).toBeUndefined()
    expect(() => expirePhaseRetryNote('1:TEST-1', 'REFINING_PRD')).not.toThrow()
  })

  it('keeps newer per-model guidance after the phase retry note', () => {
    savePhaseRetryNote('1:TEST-1', 'DRAFTING_BEADS', 'Guidance for the round')
    const original: PromptPart = { type: 'text', content: 'Approved inputs' }
    const member: PromptPart = { type: 'text', content: '## User Retry Note\nNewer guidance for this model' }
    expect(appendPhaseRetryNote([original, member], '1:TEST-1', 'DRAFTING_BEADS')).toEqual([
      original, { type: 'text', content: '## User Retry Note\nGuidance for the round' }, member,
    ])
  })

  it.each([{ note: 1 }, {}, null])('ignores a stored non-string note: %j', value => {
    artifacts.set(`1:TEST-1:REFINING_PRD:${PHASE_RETRY_NOTE_ARTIFACT}`, { content: JSON.stringify(value) })
    expect(readPhaseRetryNote('1:TEST-1', 'REFINING_PRD')).toBeUndefined()
  })

  it('enforces the exact capability projected for the active failure', () => {
    context.mockReturnValue({ previousStatus: 'CODING', availableActions: ['retry'] })
    expect(canRetryWithExtraNote('1:TEST-1', 'CODING')).toBe(false)
    context.mockReturnValue({ previousStatus: 'DRAFTING_BEADS', availableActions: ['retry', 'retry_with_note'] })
    expect(canRetryWithExtraNote('1:TEST-1', 'DRAFTING_BEADS')).toBe(true)
    expect(canRetryWithExtraNote('1:TEST-1', 'CODING')).toBe(false)
    context.mockReturnValue(undefined)
    expect(canRetryWithExtraNote('1:MISSING', 'CODING')).toBe(false)
  })
})
